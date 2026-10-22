// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// The login window of a bridgev2 `cookies` login step (spec §5.2). It loads
// the network's login page in a fresh in-memory session, waits until every
// required cookie is set, reads them and wipes the session. Cookie values
// stay in the main process: they are handed to the caller (which submits
// them to the bridge) and never logged.

import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
import type { BrowserWindowConstructorOptions, Session } from 'electron';

import { createLogger } from '../../ts/logging/log.std.ts';
import { TrukiBridgeError } from './trukiBridgeProtocol.std.ts';

const log = createLogger('TrukiCookieLogin');

// The bridge cancels a login process after 10 idle minutes; waiting longer
// than that would only submit to a process that is gone.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export type TrukiCookieRequest = { name: string; domain?: string };

export type TrukiCookieLoginOptions = {
  url: string;
  requiredCookies: ReadonlyArray<TrukiCookieRequest>;
  // Read too when present once the required ones are; never waited for.
  optionalCookies?: ReadonlyArray<TrukiCookieRequest>;
  userAgent?: string;
  // With a pattern, the window only finishes once the page URL matches it
  // too (bridgev2 `wait_for_url_pattern`).
  waitForUrlPattern?: string;
  parent?: BrowserWindow;
  // Must not be persistent; defaults to `truki-login-<uuid>`.
  partition?: string;
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export type TrukiCookieLoginResult =
  | { cookies: Record<string, string> }
  | { cancelled: true };

function compilePattern(pattern: string | undefined): RegExp | undefined {
  if (!pattern) {
    return undefined;
  }
  try {
    return new RegExp(pattern);
  } catch {
    log.warn('ignoring an invalid wait_for_url_pattern');
    return undefined;
  }
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

// A failed load still leaves the window for the user to retry or close.
// Only the reason is logged, never the URL.
async function loadInWindow(win: BrowserWindow, url: string): Promise<void> {
  try {
    await win.loadURL(url);
  } catch (error) {
    log.warn('login page did not load', (error as Error)?.message);
  }
}

// Electron grants every permission by default, and upstream's deny-by-default
// handlers cover only the default session. The login window loads remote
// pages (and their popups), so it gets nothing: no media, location,
// notifications or openExternal.
export function denyTrukiLoginPermissions(
  ses: Pick<
    Session,
    'setPermissionRequestHandler' | 'setPermissionCheckHandler'
  >
): void {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
}

async function readCookie(
  ses: Session,
  { name, domain }: TrukiCookieRequest
): Promise<string | undefined> {
  const found = await ses.cookies.get(domain ? { name, domain } : { name });
  return found.find(cookie => cookie.value !== '')?.value;
}

export async function openTrukiCookieLogin(
  opts: TrukiCookieLoginOptions
): Promise<TrukiCookieLoginResult> {
  if (!isWebUrl(opts.url)) {
    throw new TrukiBridgeError('INVALID_INPUT', 'login URL must be http(s)');
  }
  if (opts.requiredCookies.length === 0) {
    throw new TrukiBridgeError('INVALID_INPUT', 'no cookies to wait for');
  }
  const partition = opts.partition ?? `truki-login-${randomUUID()}`;
  if (partition.startsWith('persist:')) {
    throw new TrukiBridgeError(
      'INVALID_INPUT',
      'login partition must not persist'
    );
  }
  const ses = session.fromPartition(partition);
  denyTrukiLoginPermissions(ses);
  const urlPattern = compilePattern(opts.waitForUrlPattern);
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const createWindow =
    opts.createWindow ?? (options => new BrowserWindow(options));
  const win = createWindow({
    width: 900,
    height: 760,
    ...(opts.parent ? { parent: opts.parent, modal: true } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (opts.userAgent) {
    win.webContents.setUserAgent(opts.userAgent);
  }
  // Popups (an OAuth or "continue" link) open in this same window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url) && !win.isDestroyed()) {
      void loadInWindow(win, url);
    }
    return { action: 'deny' };
  });

  return new Promise<TrukiCookieLoginResult>((resolve, reject) => {
    let settled = false;
    let checking = false;
    const timers: Array<NodeJS.Timeout> = [];

    const finish = async (
      outcome:
        | { kind: 'resolve'; value: TrukiCookieLoginResult }
        | { kind: 'reject'; error: Error }
    ): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      ses.cookies.removeListener('changed', onCookiesChanged);
      try {
        await ses.clearStorageData();
      } catch (error) {
        log.warn('could not clear the login session', error);
      }
      if (!win.isDestroyed()) {
        win.destroy();
      }
      if (outcome.kind === 'resolve') {
        resolve(outcome.value);
      } else {
        reject(outcome.error);
      }
    };

    const check = async (): Promise<void> => {
      if (settled || checking || win.isDestroyed()) {
        return;
      }
      if (urlPattern && !urlPattern.test(win.webContents.getURL())) {
        return;
      }
      checking = true;
      try {
        const cookies: Record<string, string> = {};
        for (const wanted of opts.requiredCookies) {
          // eslint-disable-next-line no-await-in-loop
          const value = await readCookie(ses, wanted);
          if (value === undefined) {
            return;
          }
          cookies[wanted.name] = value;
        }
        for (const wanted of opts.optionalCookies ?? []) {
          // eslint-disable-next-line no-await-in-loop
          const value = await readCookie(ses, wanted);
          if (value !== undefined) {
            cookies[wanted.name] = value;
          }
        }
        if (!settled && !win.isDestroyed()) {
          await finish({ kind: 'resolve', value: { cookies } });
        }
      } catch (error) {
        log.warn('could not read login cookies', error);
      } finally {
        checking = false;
      }
    };

    function onCookiesChanged(): void {
      void check();
    }

    win.on('closed', () => {
      void finish({ kind: 'resolve', value: { cancelled: true } });
    });
    ses.cookies.on('changed', onCookiesChanged);
    // The URL pattern can match without a cookie change, so poll as well.
    timers.push(
      setInterval(() => {
        void check();
      }, pollIntervalMs)
    );
    timers.push(
      setTimeout(() => {
        void finish({
          kind: 'reject',
          error: new TrukiBridgeError(
            'INTERNAL',
            'cookie login timed out',
            'LOGIN_EXPIRED'
          ),
        });
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    );

    void loadInWindow(win, opts.url);
  });
}

// A bridgev2 `cookies` step, reduced to what the login window needs.
export type TrukiCookieLoginSpec = {
  url: string;
  userAgent?: string;
  waitForUrlPattern?: string;
  // Field id (the key submitted to the bridge) per cookie.
  required: ReadonlyArray<TrukiCookieRequest & { fieldId: string }>;
  optional: ReadonlyArray<TrukiCookieRequest & { fieldId: string }>;
};

function unsupported(): TrukiBridgeError {
  return new TrukiBridgeError('INVALID_INPUT', 'unsupported login step');
}

// Reads a bridgev2 LoginStep of type `cookies`. Only fields that can come
// from a cookie are supported; a required field that cannot is refused
// rather than waited for forever.
export function parseTrukiCookieLoginStep(step: unknown): TrukiCookieLoginSpec {
  const raw = step as
    | {
        type?: unknown;
        cookies?: {
          url?: unknown;
          user_agent?: unknown;
          wait_for_url_pattern?: unknown;
          fields?: unknown;
          initial_cookies?: unknown;
          hidden?: unknown;
        };
      }
    | undefined;
  const params = raw?.cookies;
  if (raw?.type !== 'cookies' || params == null) {
    throw new TrukiBridgeError('INVALID_INPUT', 'not a cookies login step');
  }
  if (typeof params.url !== 'string' || !isWebUrl(params.url)) {
    throw unsupported();
  }
  if (
    params.hidden === true ||
    (Array.isArray(params.initial_cookies) &&
      params.initial_cookies.length > 0) ||
    !Array.isArray(params.fields)
  ) {
    throw unsupported();
  }
  const required: Array<TrukiCookieRequest & { fieldId: string }> = [];
  const optional: Array<TrukiCookieRequest & { fieldId: string }> = [];
  for (const field of params.fields as Array<unknown>) {
    const {
      id,
      required: isRequired,
      sources,
    } = (field ?? {}) as {
      id?: unknown;
      required?: unknown;
      sources?: unknown;
    };
    const source = (Array.isArray(sources) ? sources : []).find(
      (s: { type?: unknown; name?: unknown } | null) =>
        s?.type === 'cookie' && typeof s.name === 'string' && s.name !== ''
    ) as { name: string; cookie_domain?: unknown } | undefined;
    if (typeof id !== 'string' || id === '' || !source) {
      if (isRequired === true) {
        throw unsupported();
      }
      continue;
    }
    const entry = {
      fieldId: id,
      name: source.name,
      ...(typeof source.cookie_domain === 'string' &&
      source.cookie_domain !== ''
        ? { domain: source.cookie_domain }
        : {}),
    };
    (isRequired === true ? required : optional).push(entry);
  }
  if (required.length === 0) {
    throw unsupported();
  }
  return {
    url: params.url,
    ...(typeof params.user_agent === 'string' && params.user_agent !== ''
      ? { userAgent: params.user_agent }
      : {}),
    ...(typeof params.wait_for_url_pattern === 'string' &&
    params.wait_for_url_pattern !== ''
      ? { waitForUrlPattern: params.wait_for_url_pattern }
      : {}),
    required,
    optional,
  };
}

// Runs the login window for a cookies step and maps the cookies it read to
// the step's field ids, ready for `login.submit`.
export async function collectTrukiStepCookies(
  step: unknown,
  {
    open = openTrukiCookieLogin,
    parent,
  }: {
    open?: typeof openTrukiCookieLogin;
    parent?: BrowserWindow;
  } = {}
): Promise<{ cookies: Record<string, string> } | { cancelled: true }> {
  const spec = parseTrukiCookieLoginStep(step);
  const result = await open({
    url: spec.url,
    requiredCookies: spec.required.map(({ name, domain }) => ({
      name,
      ...(domain ? { domain } : {}),
    })),
    optionalCookies: spec.optional.map(({ name, domain }) => ({
      name,
      ...(domain ? { domain } : {}),
    })),
    ...(spec.userAgent ? { userAgent: spec.userAgent } : {}),
    ...(spec.waitForUrlPattern
      ? { waitForUrlPattern: spec.waitForUrlPattern }
      : {}),
    ...(parent ? { parent } : {}),
  });
  if ('cancelled' in result) {
    return result;
  }
  const byField: Record<string, string> = {};
  for (const { fieldId, name } of [...spec.required, ...spec.optional]) {
    const value = result.cookies[name];
    if (value !== undefined) {
      byField[fieldId] = value;
    }
  }
  return { cookies: byField };
}
