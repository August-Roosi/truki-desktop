// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { assert } from 'chai';
import { BrowserWindow, session } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';

import {
  openTrukiCookieLogin,
  parseTrukiCookieLoginStep,
} from '../../../app/truki/trukiCookieLogin.main.ts';
import type { TrukiBridgeError } from '../../../app/truki/trukiBridgeProtocol.std.ts';
import { startTrukiFakeLoginPage } from './fixtures/trukiFakeLoginPage.node.mjs';

type FakeSite = Awaited<ReturnType<typeof startTrukiFakeLoginPage>>;

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 8000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => {
      setTimeout(resolve, 10);
    });
  }
}

describe('TrukiCookieLogin', () => {
  let site: FakeSite;
  let windows: Array<BrowserWindow>;
  let windowOptions: Array<BrowserWindowConstructorOptions>;
  let partition: string;

  // Hidden windows, so the tests run under xvfb without flashing anything.
  const createWindow = (options: BrowserWindowConstructorOptions) => {
    windowOptions.push(options);
    const win = new BrowserWindow({ ...options, show: false });
    windows.push(win);
    return win;
  };

  async function partitionCookieCount(): Promise<number> {
    return (await session.fromPartition(partition).cookies.get({})).length;
  }

  beforeEach(async () => {
    site = await startTrukiFakeLoginPage();
    windows = [];
    windowOptions = [];
    partition = `truki-login-test-${randomUUID()}`;
  });

  afterEach(async () => {
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    }
    await site.close();
  });

  it('resolves with the cookies after the form post and wipes the session', async () => {
    const login = openTrukiCookieLogin({
      url: `${site.origin}/`,
      requiredCookies: [
        { name: 'c_user' },
        { name: 'xs', domain: '127.0.0.1' },
      ],
      optionalCookies: [{ name: 'absent' }],
      userAgent: 'TrukiTestAgent/1.0',
      partition,
      createWindow,
      pollIntervalMs: 50,
    });
    await waitFor(() => windows.length === 1, 'the login window');
    const win = windows[0];
    assert.isDefined(win);
    if (!win) {
      return;
    }
    const prefs = windowOptions[0]?.webPreferences;
    assert.include(prefs, {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    assert.isUndefined(prefs?.preload);
    await waitFor(
      () => win.webContents.getURL().startsWith(site.origin),
      'the login page'
    );
    await waitFor(() => !win.webContents.isLoading(), 'the page to load');
    await win.webContents.executeJavaScript('document.forms[0].submit()');

    assert.deepEqual(await login, {
      cookies: { c_user: 'value-of-c_user', xs: 'value-of-xs' },
    });
    assert.isTrue(win.isDestroyed());
    assert.strictEqual(await partitionCookieCount(), 0);
    assert.include(site.userAgents, 'TrukiTestAgent/1.0');
  });

  it('returns cancelled when the user closes the window', async () => {
    const login = openTrukiCookieLogin({
      url: `${site.origin}/set?cookies=c_user`,
      requiredCookies: [{ name: 'c_user' }, { name: 'xs' }],
      partition,
      createWindow,
      pollIntervalMs: 50,
    });
    await waitFor(() => windows.length === 1, 'the login window');
    await waitFor(() => site.userAgents.length > 0, 'the page request');
    windows[0]?.close();
    assert.deepEqual(await login, { cancelled: true });
    assert.strictEqual(await partitionCookieCount(), 0);
  });

  it('fails when a required cookie never appears', async () => {
    const login = openTrukiCookieLogin({
      url: `${site.origin}/set?cookies=c_user`,
      requiredCookies: [{ name: 'c_user' }, { name: 'xs' }],
      partition,
      createWindow,
      timeoutMs: 1500,
      pollIntervalMs: 50,
    });
    let error: unknown;
    try {
      await login;
    } catch (e) {
      error = e;
    }
    assert.strictEqual(
      (error as TrukiBridgeError | undefined)?.code,
      'INTERNAL'
    );
    assert.strictEqual(
      (error as TrukiBridgeError | undefined)?.bridgeCode,
      'LOGIN_EXPIRED'
    );
    assert.isTrue(windows[0]?.isDestroyed());
    assert.strictEqual(await partitionCookieCount(), 0);
  });

  it('waits for the URL pattern as well as the cookies', async () => {
    const login = openTrukiCookieLogin({
      url: `${site.origin}/set?cookies=c_user,xs`,
      requiredCookies: [{ name: 'c_user' }, { name: 'xs' }],
      waitForUrlPattern: '/home$',
      partition,
      createWindow,
      pollIntervalMs: 50,
    });
    let settled = false;
    void (async () => {
      try {
        await login;
      } finally {
        settled = true;
      }
    })();
    await waitFor(() => windows.length === 1, 'the login window');
    const win = windows[0];
    if (!win) {
      throw new Error('no window');
    }
    await waitFor(
      () => win.webContents.getURL().includes('/set'),
      'the set page'
    );
    await waitFor(() => !win.webContents.isLoading(), 'the page to load');
    await new Promise(resolve => {
      setTimeout(resolve, 300);
    });
    assert.isFalse(settled, 'cookies alone must not finish');
    await win.loadURL(`${site.origin}/home`);
    assert.deepEqual(await login, {
      cookies: { c_user: 'value-of-c_user', xs: 'value-of-xs' },
    });
  });

  it('opens popups in the login window itself', async () => {
    const before = BrowserWindow.getAllWindows().length;
    const login = openTrukiCookieLogin({
      url: `${site.origin}/popup?cookies=c_user`,
      requiredCookies: [{ name: 'c_user' }],
      partition,
      createWindow,
      pollIntervalMs: 50,
    });
    assert.deepEqual(await login, { cookies: { c_user: 'value-of-c_user' } });
    assert.strictEqual(BrowserWindow.getAllWindows().length, before);
  });

  it('refuses a persistent partition and a non-web URL', async () => {
    for (const opts of [
      { url: `${site.origin}/`, partition: 'persist:truki-login-x' },
      { url: 'file:///etc/passwd' },
    ]) {
      let error: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop
        await openTrukiCookieLogin({
          ...opts,
          requiredCookies: [{ name: 'c_user' }],
          createWindow,
        });
      } catch (e) {
        error = e;
      }
      assert.strictEqual(
        (error as TrukiBridgeError | undefined)?.code,
        'INVALID_INPUT'
      );
    }
    assert.strictEqual(windows.length, 0);
  });

  describe('parseTrukiCookieLoginStep', () => {
    const igStep = {
      type: 'cookies',
      step_id: 'fi.mau.instagram.cookies',
      cookies: {
        url: 'https://www.instagram.com/accounts/login/',
        wait_for_url_pattern: '^https://www\\.instagram\\.com/',
        fields: [
          {
            id: 'sessionid',
            required: true,
            sources: [
              {
                type: 'cookie',
                name: 'sessionid',
                cookie_domain: 'instagram.com',
              },
            ],
          },
          {
            id: 'rur',
            required: false,
            sources: [
              { type: 'cookie', name: 'rur', cookie_domain: 'instagram.com' },
            ],
          },
          {
            id: 'extra',
            required: false,
            sources: [{ type: 'special', name: 'fi.mau.x' }],
          },
        ],
      },
    };

    it('reads required and optional cookie fields', () => {
      assert.deepEqual(parseTrukiCookieLoginStep(igStep), {
        url: 'https://www.instagram.com/accounts/login/',
        waitForUrlPattern: '^https://www\\.instagram\\.com/',
        required: [
          { fieldId: 'sessionid', name: 'sessionid', domain: 'instagram.com' },
        ],
        optional: [{ fieldId: 'rur', name: 'rur', domain: 'instagram.com' }],
      });
    });

    it('refuses steps it cannot complete', () => {
      const bad: Array<unknown> = [
        { type: 'user_input', user_input: {} },
        { ...igStep, cookies: { ...igStep.cookies, hidden: true } },
        { ...igStep, cookies: { ...igStep.cookies, url: 'data:text/html,x' } },
        {
          ...igStep,
          cookies: {
            ...igStep.cookies,
            fields: [
              {
                id: 'auth',
                required: true,
                sources: [{ type: 'request_header', name: 'authorization' }],
              },
            ],
          },
        },
      ];
      for (const step of bad) {
        let error: unknown;
        try {
          parseTrukiCookieLoginStep(step);
        } catch (e) {
          error = e;
        }
        assert.strictEqual(
          (error as TrukiBridgeError | undefined)?.code,
          'INVALID_INPUT',
          JSON.stringify(step)
        );
      }
    });
  });
});
