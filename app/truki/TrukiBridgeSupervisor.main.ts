// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { app, dialog, ipcMain, net, protocol, safeStorage } from 'electron';
import type { BrowserWindow } from 'electron';

import { createLogger } from '../../ts/logging/log.std.ts';
import { getAppRootDir } from '../../ts/util/appRootDir.main.ts';
import {
  TRUKI_BRIDGE_PROTOCOL_VERSION,
  TrukiBridgeError,
  isTrukiBridgeErrorCode,
  mxcToTrukiMediaUrl,
  trukiMediaUrlToMxc,
} from './trukiBridgeProtocol.std.ts';
import {
  collectTrukiStepCookies,
  openTrukiCookieLogin,
} from './trukiCookieLogin.main.ts';
import type {
  TrukiBridgeEvent,
  TrukiCookieLoginParams,
  TrukiBridgeIpcResult,
  TrukiPickAttachmentParams,
  TrukiSaveMediaParams,
  TrukiSupervisorStateName,
} from './trukiBridgeProtocol.std.ts';

const log = createLogger('TrukiBridge');

const BRIDGE_DIR_NAME = 'truki-bridge';
const KEY_FILE_NAME = 'truki-bridge.key';
const SETTINGS_FILE_NAME = 'settings.json';
const SHUTDOWN_KILL_MS = 5000;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_CRASHES_IN_WINDOW = 5;
const BACKOFF_BASE_MS = 1000;

export type TrukiBridgeSupervisorState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'backoff'
  | 'gave-up';

export type TrukiBridgeSupervisorOptions = {
  binaryPath: string;
  userDataPath: string;
  encryptKey: (plain: string) => Buffer<ArrayBuffer>;
  decryptKey: (enc: Buffer<ArrayBuffer>) => string;
  isEncryptionAvailable: () => boolean;
  onEvent: (e: TrukiBridgeEvent) => void;
  // Called on every state change (see emitState()).
  onStateChange?: (state: TrukiSupervisorStateName) => void;
  // Window the attachment dialog is modal to, if any.
  getParentWindow?: () => BrowserWindow | undefined;
  // Test seams
  showOpenDialog?: typeof dialog.showOpenDialog;
  showSaveDialog?: typeof dialog.showSaveDialog;
  openCookieLogin?: typeof openTrukiCookieLogin;
  spawnFn?: typeof spawn;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

// The latest step (highest seq) of a login process, as the bridge reported
// it in a result or an event.login.step.
type LoginStepRecord = {
  network: string | undefined;
  seq: number;
  step: unknown;
};

type Run = {
  child: ChildProcess;
  pending: Map<number, Pending>;
  stopping: boolean;
  closed: boolean;
  closedPromise: Promise<void>;
};

async function swallow(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // The caller of the promise sees the error; nothing to do here.
  }
}

async function logRejection(
  promise: Promise<unknown>,
  what: string
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    log.error(what, error);
  }
}

function toBridgeError(error: unknown): TrukiBridgeError {
  const data = (error as { data?: { code?: unknown } } | undefined)?.data;
  const rawMessage = (error as { message?: unknown } | undefined)?.message;
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  const code = data?.code;
  if (isTrukiBridgeErrorCode(code)) {
    return new TrukiBridgeError(code, message);
  }
  return new TrukiBridgeError(
    'INTERNAL',
    message,
    typeof code === 'string' ? code : undefined
  );
}

export class TrukiBridgeSupervisor {
  readonly #opts: TrukiBridgeSupervisorOptions;
  readonly #bridgeDir: string;
  #state: TrukiBridgeSupervisorState = 'stopped';
  #enabledNetworks: Array<string>;
  #run: Run | undefined;
  #ready: Promise<void> | undefined;
  #nextId = 1;
  #crashTimes: Array<number> = [];
  #restartTimer: NodeJS.Timeout | undefined;
  // Set when the bridge can never work (incompatible, unusable key).
  #fatal: TrukiBridgeError | undefined;
  // Set by shutdown(): the supervisor never starts the bridge again.
  #closed = false;
  // A JSON line that is not an object is logged once, without its content.
  #warnedNonObject = false;
  #lastReportedState: TrukiSupervisorStateName | undefined;
  #warnedUnavailable = false;
  // Lifecycle transitions (stop, start, restart, shutdown, crash restart)
  // run one at a time through this chain, so two of them never interleave
  // around the awaited stop and leave a bridge running unreferenced.
  #lifecycle: Promise<void> = Promise.resolve();
  #restarting: Promise<void> | undefined;
  readonly #loginSteps = new Map<string, LoginStepRecord>();
  readonly #cookieLogins = new Set<string>();

  constructor(opts: TrukiBridgeSupervisorOptions) {
    this.#opts = opts;
    this.#bridgeDir = join(opts.userDataPath, BRIDGE_DIR_NAME);
    this.#enabledNetworks = this.#loadSettings();
  }

  get state(): TrukiBridgeSupervisorState {
    return this.#state;
  }

  // 'unavailable' (no secure storage) takes precedence: nothing can start.
  get reportedState(): TrukiSupervisorStateName {
    return this.#opts.isEncryptionAvailable() ? this.#state : 'unavailable';
  }

  // Reports the current state to onStateChange even if it did not change;
  // used once at startup. State changes are reported by themselves.
  emitState(): void {
    this.#lastReportedState = undefined;
    this.#reportState();
  }

  #setState(state: TrukiBridgeSupervisorState): void {
    this.#state = state;
    this.#reportState();
  }

  #reportState(): void {
    const state = this.reportedState;
    if (state === 'unavailable' && !this.#warnedUnavailable) {
      this.#warnedUnavailable = true;
      log.warn('secure storage is not available, the bridge cannot start');
    }
    if (state === this.#lastReportedState) {
      return;
    }
    this.#lastReportedState = state;
    try {
      this.#opts.onStateChange?.(state);
    } catch (error) {
      log.error('onStateChange handler threw', error);
    }
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycle;
    const result = (async () => {
      await previous;
      return fn();
    })();
    this.#lifecycle = swallow(result);
    return result;
  }

  getEnabledNetworks(): ReadonlyArray<string> {
    return this.#enabledNetworks;
  }

  async setEnabledNetworks(ids: ReadonlyArray<string>): Promise<void> {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
      throw new TrukiBridgeError('INVALID_INPUT', 'ids must be strings');
    }
    this.#enabledNetworks = [...ids];
    this.#reportState();
    fs.mkdirSync(this.#bridgeDir, { recursive: true });
    fs.writeFileSync(
      join(this.#bridgeDir, SETTINGS_FILE_NAME),
      JSON.stringify({ enabledNetworks: this.#enabledNetworks })
    );

    await this.#enqueue(async () => {
      if (this.#enabledNetworks.length === 0) {
        await this.#stop();
        return;
      }
      if (this.#canStart() && this.#state === 'stopped') {
        this.#start();
      }
    });
  }

  // Stops the bridge if it runs, forgets earlier crashes (and a give-up),
  // and starts it again when a network is enabled. The Restart button of
  // the "Bridges stopped" banner.
  async restart(): Promise<void> {
    if (this.#closed) {
      throw new TrukiBridgeError('BRIDGE_STOPPED', 'bridge was shut down');
    }
    // A restart asked for while one is in flight is that restart.
    if (this.#restarting) {
      return this.#restarting;
    }
    const restarting = this.#enqueue(async () => {
      // shutdown() wins over a restart queued before it.
      if (this.#closed) {
        return;
      }
      await this.#stop();
      this.#crashTimes = [];
      this.#fatal = undefined;
      if (this.#state !== 'stopped') {
        this.#setState('stopped');
      }
      if (this.#enabledNetworks.length > 0 && this.#canStart()) {
        this.#start();
      }
    });
    this.#restarting = restarting;
    const clear = () => {
      if (this.#restarting === restarting) {
        this.#restarting = undefined;
      }
    };
    void (async () => {
      await swallow(restarting);
      clear();
    })();
    return restarting;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    // The supervisor owns the lifecycle; callers must not drive it.
    if (method === 'init' || method === 'shutdown') {
      throw new TrukiBridgeError(
        'INVALID_INPUT',
        `${method} is reserved for the supervisor`
      );
    }
    if (this.#closed) {
      throw new TrukiBridgeError('BRIDGE_STOPPED', 'bridge was shut down');
    }
    if (this.#fatal) {
      throw this.#fatal;
    }
    if (!this.#opts.isEncryptionAvailable()) {
      throw new TrukiBridgeError(
        'BRIDGE_UNAVAILABLE',
        'secure storage is not available'
      );
    }
    if (this.#enabledNetworks.length === 0) {
      throw new TrukiBridgeError('BRIDGE_UNAVAILABLE', 'no network is enabled');
    }
    if (this.#state === 'gave-up') {
      throw new TrukiBridgeError('BRIDGE_STOPPED', 'bridge keeps crashing');
    }
    if (this.#state === 'backoff') {
      throw new TrukiBridgeError('BRIDGE_UNAVAILABLE', 'bridge is restarting');
    }
    if (this.#state === 'stopped') {
      this.#start();
    }
    if (this.#ready) {
      await this.#ready;
    }
    const run = this.#run;
    if (!run || run.stopping || run.closed) {
      throw new TrukiBridgeError('BRIDGE_UNAVAILABLE', 'bridge is not running');
    }
    let result: unknown;
    try {
      result = await this.#send(run, method, params);
    } catch (error) {
      this.#noteLoginFailure(method, params, error);
      throw error;
    }
    this.#noteLoginResult(method, params, result);
    return result as T;
  }

  #noteLoginStep(
    processId: unknown,
    seq: unknown,
    step: unknown,
    network?: string
  ): void {
    if (typeof processId !== 'string' || typeof seq !== 'number') {
      return;
    }
    const known = this.#loginSteps.get(processId);
    if (known && known.seq >= seq) {
      // An event can arrive before the login.start result that names the
      // network.
      if (known.network === undefined && network !== undefined) {
        known.network = network;
      }
      return;
    }
    if ((step as { type?: unknown } | undefined)?.type === 'complete') {
      this.#loginSteps.delete(processId);
      return;
    }
    this.#loginSteps.set(processId, {
      network: network ?? known?.network,
      seq,
      step,
    });
  }

  #noteLoginResult(method: string, params: unknown, result: unknown): void {
    const p = params as { processId?: unknown; network?: unknown } | undefined;
    const r = result as
      | { processId?: unknown; seq?: unknown; step?: unknown }
      | undefined;
    if (method === 'login.start') {
      const network = typeof p?.network === 'string' ? p.network : undefined;
      // A second login.start for a network cancels the first process.
      for (const [id, record] of this.#loginSteps) {
        if (network !== undefined && record.network === network) {
          this.#loginSteps.delete(id);
        }
      }
      this.#noteLoginStep(r?.processId, r?.seq, r?.step, network);
    } else if (method === 'login.submit') {
      this.#noteLoginStep(p?.processId, r?.seq, r?.step);
    } else if (method === 'login.cancel' && typeof p?.processId === 'string') {
      this.#loginSteps.delete(p.processId);
    }
  }

  // A submit the network rejected (LOGIN_FAILED) or an unknown process
  // (NOT_FOUND) means the process is gone.
  #noteLoginFailure(method: string, params: unknown, error: unknown): void {
    const processId = (params as { processId?: unknown } | undefined)
      ?.processId;
    if (
      (method === 'login.submit' || method === 'login.cancel') &&
      typeof processId === 'string' &&
      error instanceof TrukiBridgeError &&
      (error.code === 'NOT_FOUND' || error.bridgeCode === 'LOGIN_FAILED')
    ) {
      this.#loginSteps.delete(processId);
    }
  }

  #noteLoginEvent(params: unknown): void {
    const p = params as
      | { processId?: unknown; seq?: unknown; step?: unknown; error?: unknown }
      | undefined;
    if (p?.error != null) {
      if (typeof p.processId === 'string') {
        this.#loginSteps.delete(p.processId);
      }
      return;
    }
    this.#noteLoginStep(p?.processId, p?.seq, p?.step);
  }

  // Runs the login window for the current `cookies` step of a login process
  // and submits what it collected. The step (and so the URL and cookie
  // names) comes from what the bridge reported, never from the renderer, and
  // the result carries no cookie value.
  async cookieLogin(
    params: TrukiCookieLoginParams
  ): Promise<{ cancelled: true } | { step: unknown; seq: number }> {
    const { processId, stepId } = (params ?? {}) as Partial<
      Record<keyof TrukiCookieLoginParams, unknown>
    >;
    if (
      typeof processId !== 'string' ||
      processId === '' ||
      typeof stepId !== 'string' ||
      stepId === ''
    ) {
      throw new TrukiBridgeError(
        'INVALID_INPUT',
        'invalid cookie login params'
      );
    }
    const record = this.#loginSteps.get(processId);
    if (!record) {
      throw new TrukiBridgeError('NOT_FOUND', 'unknown login process');
    }
    const step = record.step as { type?: unknown; step_id?: unknown };
    if (step?.step_id !== stepId || step?.type !== 'cookies') {
      throw new TrukiBridgeError(
        'INVALID_INPUT',
        'not the current cookies step'
      );
    }
    if (this.#cookieLogins.has(processId)) {
      throw new TrukiBridgeError(
        'INVALID_INPUT',
        'cookie login is already open'
      );
    }
    this.#cookieLogins.add(processId);
    try {
      const collected = await collectTrukiStepCookies(record.step, {
        open: this.#opts.openCookieLogin ?? openTrukiCookieLogin,
        parent: this.#opts.getParentWindow?.(),
      });
      if ('cancelled' in collected) {
        return { cancelled: true };
      }
      const result = await this.request<{ step?: unknown; seq?: unknown }>(
        'login.submit',
        { processId, stepId, cookies: collected.cookies }
      );
      return {
        step: withoutTrukiLoginSecrets(result?.step),
        seq: typeof result?.seq === 'number' ? result.seq : 0,
      };
    } finally {
      this.#cookieLogins.delete(processId);
    }
  }

  // Shows a file dialog in the main process and hands the chosen path to the
  // bridge, so the renderer never names a path (ruling R19).
  async pickAttachment(
    params: TrukiPickAttachmentParams
  ): Promise<{ eventId: string } | { cancelled: true }> {
    const { chatId, caption, replyTo } = (params ?? {}) as Partial<
      Record<keyof TrukiPickAttachmentParams, unknown>
    >;
    if (
      typeof chatId !== 'string' ||
      chatId === '' ||
      (caption !== undefined && typeof caption !== 'string') ||
      (replyTo !== undefined && typeof replyTo !== 'string')
    ) {
      throw new TrukiBridgeError('INVALID_INPUT', 'invalid attachment params');
    }
    const showOpenDialog = this.#opts.showOpenDialog ?? dialog.showOpenDialog;
    const options = { properties: ['openFile' as const] };
    const parent = this.#opts.getParentWindow?.();
    const result = parent
      ? await showOpenDialog(parent, options)
      : await showOpenDialog(options);
    const filePath = result.filePaths[0];
    if (result.canceled || filePath === undefined) {
      return { cancelled: true };
    }
    return this.request<{ eventId: string }>('messages.send', {
      chatId,
      text: caption ?? '',
      replyTo,
      attachments: [{ path: filePath, name: basename(filePath) }],
    });
  }

  // Saves a received media file where the user chooses (spec §4.2). Only a
  // bridge media id is accepted; the renderer never names a path.
  async saveMedia(
    params: TrukiSaveMediaParams
  ): Promise<{ saved: true } | { cancelled: true }> {
    return saveTrukiMedia(params, {
      mediaDir: join(this.#bridgeDir, 'media'),
      request: (method, p) => this.request(method, p),
      showSaveDialog: this.#opts.showSaveDialog ?? dialog.showSaveDialog,
      parent: this.#opts.getParentWindow?.(),
    });
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.#enqueue(async () => this.#stop());
  }

  #canStart(): boolean {
    return (
      !this.#closed &&
      !this.#fatal &&
      this.#opts.isEncryptionAvailable() &&
      this.#state !== 'gave-up'
    );
  }

  #loadSettings(): Array<string> {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(join(this.#bridgeDir, SETTINGS_FILE_NAME), 'utf8')
      );
      const ids = parsed?.enabledNetworks;
      if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
        return ids;
      }
    } catch {
      // No (readable) settings yet.
    }
    return [];
  }

  // Returns the hex key, creating and storing one on first use. A key file
  // that exists but cannot be read is an error: a new key would lock the
  // user out of the existing database.
  #loadOrCreateKey(): string {
    const keyPath = join(this.#bridgeDir, KEY_FILE_NAME);
    let stored: Buffer<ArrayBuffer> | undefined;
    try {
      stored = fs.readFileSync(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (stored) {
      const hex = this.#opts.decryptKey(stored);
      if (!/^[0-9a-f]{64}$/.test(hex)) {
        throw new Error('stored key is malformed');
      }
      return hex;
    }
    const hex = randomBytes(32).toString('hex');
    fs.mkdirSync(this.#bridgeDir, { recursive: true });
    // Write beside the key and rename over it, so a crash never leaves a
    // half-written key file. A .tmp left by an earlier crash is overwritten.
    const tmpPath = `${keyPath}.tmp`;
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, this.#opts.encryptKey(hex));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, keyPath);
    return hex;
  }

  #start(): void {
    this.#setState('starting');
    let run: Run;
    let key: string;
    try {
      key = this.#loadOrCreateKey();
      run = this.#spawn();
    } catch (error) {
      log.error('could not start bridge', error);
      this.#fatal = new TrukiBridgeError(
        'BRIDGE_UNAVAILABLE',
        'could not start the bridge'
      );
      this.#setState('gave-up');
      this.#ready = undefined;
      return;
    }
    this.#run = run;
    const ready = this.#handshake(key);
    // Requests awaiting `ready` see the rejection; this keeps it from being
    // reported as unhandled when nobody is waiting.
    void swallow(ready);
    this.#ready = ready;
  }

  #spawn(): Run {
    const spawnFn = this.#opts.spawnFn ?? spawn;
    const child = spawnFn(this.#opts.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });
    const run: Run = {
      child,
      pending: new Map(),
      stopping: false,
      closed: false,
      closedPromise: Promise.resolve(),
    };

    run.closedPromise = new Promise<void>(resolvePromise => {
      let handled = false;
      const onGone = (detail: string) => {
        if (handled) {
          return;
        }
        handled = true;
        run.closed = true;
        this.#onExit(run, detail);
        resolvePromise();
      };
      // 'close' comes after stdout is drained, so events sent right before
      // exit are still delivered.
      child.once('close', (code, signal) => {
        onGone(`code=${code} signal=${signal}`);
      });
      child.once('error', error => {
        log.error('bridge process error', error);
        onGone('spawn error');
      });
    });

    child.stdin?.on('error', error => {
      log.warn('bridge stdin error', error);
    });
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', line => {
        this.#onLine(run, line);
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', line => {
        log.info(line);
      });
    }
    return run;
  }

  async #handshake(key: string): Promise<void> {
    const run = this.#run;
    if (!run) {
      throw new TrukiBridgeError('BRIDGE_UNAVAILABLE', 'bridge is not running');
    }
    try {
      const result = (await this.#send(run, 'init', {
        protocolVersion: TRUKI_BRIDGE_PROTOCOL_VERSION,
        dataDir: this.#bridgeDir,
        dbKey: key,
      })) as { protocolVersion?: unknown } | undefined;
      if (result?.protocolVersion !== TRUKI_BRIDGE_PROTOCOL_VERSION) {
        throw new TrukiBridgeError(
          'BRIDGE_INCOMPATIBLE',
          `bridge speaks protocol ${String(result?.protocolVersion)}, want ${TRUKI_BRIDGE_PROTOCOL_VERSION}`
        );
      }
    } catch (error) {
      let failure = error;
      if (error instanceof TrukiBridgeError && error.code === 'INVALID_INPUT') {
        // The bridge answers INVALID_INPUT to a protocolVersion it rejects.
        failure = new TrukiBridgeError('BRIDGE_INCOMPATIBLE', error.message);
      }
      if (
        failure instanceof TrukiBridgeError &&
        failure.code === 'BRIDGE_INCOMPATIBLE'
      ) {
        this.#fatal = failure;
        this.#setState('gave-up');
        run.stopping = true;
      }
      if (!run.closed) {
        run.child.kill();
      }
      throw failure;
    }
    if (this.#run === run && !run.stopping && !run.closed) {
      this.#setState('running');
    }
  }

  #send(run: Run, method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<unknown>((resolvePromise, reject) => {
      if (run.closed || !run.child.stdin?.writable) {
        reject(
          new TrukiBridgeError('BRIDGE_UNAVAILABLE', 'bridge is not running')
        );
        return;
      }
      run.pending.set(id, { resolve: resolvePromise, reject });
      const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      run.child.stdin.write(line, error => {
        if (error && run.pending.delete(id)) {
          reject(
            new TrukiBridgeError(
              'BRIDGE_UNAVAILABLE',
              'could not write to bridge'
            )
          );
        }
      });
    });
  }

  #onLine(run: Run, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn('bridge sent a line that is not JSON');
      return;
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (!this.#warnedNonObject) {
        this.#warnedNonObject = true;
        log.warn('bridge sent a JSON line that is not an object');
      }
      return;
    }
    const message = parsed as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };

    if (typeof message.id === 'number') {
      const pending = run.pending.get(message.id);
      if (!pending) {
        return;
      }
      run.pending.delete(message.id);
      if (message.error) {
        pending.reject(toBridgeError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (
      message.id === undefined &&
      typeof message.method === 'string' &&
      message.method.startsWith('event.')
    ) {
      if (message.method === 'event.login.step') {
        this.#noteLoginEvent(message.params);
      }
      try {
        this.#opts.onEvent({
          method: message.method as `event.${string}`,
          params: message.params,
        });
      } catch (error) {
        log.error('onEvent handler threw', error);
      }
    }
  }

  #failPending(run: Run, error: TrukiBridgeError): void {
    const pending = [...run.pending.values()];
    run.pending.clear();
    for (const entry of pending) {
      entry.reject(error);
    }
  }

  #onExit(run: Run, detail: string): void {
    this.#failPending(
      run,
      new TrukiBridgeError('BRIDGE_UNAVAILABLE', 'bridge process exited')
    );
    if (this.#run === run) {
      this.#run = undefined;
      // The bridge's login processes die with it.
      this.#loginSteps.clear();
    }
    if (run.stopping) {
      return;
    }

    log.warn(`bridge exited unexpectedly (${detail})`);
    const now = (this.#opts.now ?? Date.now)();
    this.#crashTimes = this.#crashTimes.filter(t => now - t < CRASH_WINDOW_MS);
    this.#crashTimes.push(now);

    if (this.#crashTimes.length >= MAX_CRASHES_IN_WINDOW) {
      log.error('bridge crashed too often, giving up');
      this.#setState('gave-up');
      return;
    }
    const delay = BACKOFF_BASE_MS * 2 ** (this.#crashTimes.length - 1);
    this.#setState('backoff');
    const timeoutFn = this.#opts.setTimeoutFn ?? setTimeout;
    this.#restartTimer = timeoutFn(() => {
      this.#restartTimer = undefined;
      void swallow(
        this.#enqueue(async () => {
          if (this.#state === 'backoff' && this.#canStart()) {
            this.#start();
          }
        })
      );
    }, delay);
  }

  async #stop(): Promise<void> {
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    const run = this.#run;
    if (run && !run.closed) {
      run.stopping = true;
      const timeoutFn = this.#opts.setTimeoutFn ?? setTimeout;
      const killTimer = timeoutFn(() => {
        log.warn('bridge did not exit after shutdown, killing it');
        run.child.kill('SIGKILL');
      }, SHUTDOWN_KILL_MS);
      void swallow(this.#send(run, 'shutdown'));
      await run.closedPromise;
      clearTimeout(killTimer);
    }
    this.#run = undefined;
    this.#ready = undefined;
    if (this.#state !== 'gave-up') {
      this.#setState('stopped');
    }
  }
}

// A step handed back to the renderer must not carry cookie values: a
// following cookies step may list initial_cookies.
export function withoutTrukiLoginSecrets(step: unknown): unknown {
  const cookies = (step as { cookies?: unknown } | null | undefined)?.cookies;
  if (cookies == null || typeof cookies !== 'object') {
    return step;
  }
  const rest: Record<string, unknown> = { ...cookies };
  delete rest.initial_cookies;
  return { ...(step as object), cookies: rest };
}

// What the renderer pulls right after subscribing: the startup emission
// happens before any window exists.
export function getTrukiBridgeState(
  supervisor: Pick<TrukiBridgeSupervisor, 'reportedState'>
): TrukiSupervisorStateName {
  return supervisor.reportedState;
}

export function shouldDelayQuitForBridge(
  state: TrukiBridgeSupervisorState,
  alreadyShuttingDown: boolean
): boolean {
  return (
    !alreadyShuttingDown &&
    (state === 'running' || state === 'starting' || state === 'backoff')
  );
}

export async function toTrukiBridgeIpcResult<T>(
  fn: () => Promise<T>
): Promise<TrukiBridgeIpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof TrukiBridgeError) {
      return {
        ok: false,
        code: error.code,
        ...(error.bridgeCode === undefined
          ? {}
          : { bridgeCode: error.bridgeCode }),
        message: error.message,
      };
    }
    log.error('unexpected error in bridge IPC handler', error);
    return { ok: false, code: 'INTERNAL', message: 'internal error' };
  }
}

// The renderer's entry point into the bridge. Unlike request(), which trusts
// its main-process callers, it refuses anything that would make the bridge
// read a file path chosen by the renderer.
export async function handleTrukiBridgeIpcRequest(
  supervisor: Pick<TrukiBridgeSupervisor, 'request'>,
  method: unknown,
  params: unknown
): Promise<unknown> {
  if (typeof method !== 'string') {
    throw new TrukiBridgeError('INVALID_INPUT', 'method must be a string');
  }
  if (method === 'messages.send') {
    const attachments = (params as { attachments?: unknown } | null | undefined)
      ?.attachments;
    if (
      attachments != null &&
      !(Array.isArray(attachments) && attachments.length === 0)
    ) {
      throw new TrukiBridgeError(
        'INVALID_INPUT',
        'attachments over IPC are not supported yet'
      );
    }
  }
  return supervisor.request(method, params);
}

export function getTrukiBridgeBinaryPath({
  isPackaged,
  resourcesPath,
  appRoot,
  platform,
  arch,
}: {
  isPackaged: boolean;
  resourcesPath: string;
  appRoot: string;
  platform: NodeJS.Platform;
  arch: string;
}): string {
  const fileName = platform === 'win32' ? 'truki-bridge.exe' : 'truki-bridge';
  if (isPackaged) {
    return join(resourcesPath, fileName);
  }
  const goos = platform === 'win32' ? 'windows' : platform;
  const goarch = arch === 'x64' ? 'amd64' : arch;
  return join(appRoot, 'truki-bridge', 'dist', `${goos}-${goarch}`, fileName);
}

// Returns the real path of `candidate` if it is a file inside `mediaDir`,
// otherwise undefined (outside, missing, or a symlink out of the directory).
export function resolveTrukiMediaPath(
  mediaDir: string,
  candidate: string
): string | undefined {
  try {
    const root = fs.realpathSync(resolve(mediaDir));
    const real = fs.realpathSync(resolve(candidate));
    if (real.startsWith(root + sep) && fs.statSync(real).isFile()) {
      return real;
    }
  } catch {
    // Missing or unreadable.
  }
  return undefined;
}

const MAX_SAVE_NAME_LENGTH = 200;

// A plain file name from a name the network supplied: no directories, no
// control characters, never empty or a dot name.
export function sanitizeTrukiSaveName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const last = raw.split(/[\\/]/).pop() ?? '';
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (clean === '' || clean === '.' || clean === '..') {
    return 'file';
  }
  return clean.slice(0, MAX_SAVE_NAME_LENGTH);
}

export async function saveTrukiMedia(
  params: TrukiSaveMediaParams,
  {
    mediaDir,
    request,
    showSaveDialog,
    parent,
  }: {
    mediaDir: string;
    request: <T>(method: string, params: unknown) => Promise<T>;
    showSaveDialog: typeof dialog.showSaveDialog;
    parent: BrowserWindow | undefined;
  }
): Promise<{ saved: true } | { cancelled: true }> {
  const { mxc, suggestedName } = (params ?? {}) as Partial<
    Record<keyof TrukiSaveMediaParams, unknown>
  >;
  const mediaUrl =
    typeof mxc === 'string' ? mxcToTrukiMediaUrl(mxc) : undefined;
  const mediaId = mediaUrl ? trukiMediaUrlToMxc(mediaUrl) : undefined;
  if (
    !mediaId ||
    (suggestedName !== undefined && typeof suggestedName !== 'string')
  ) {
    throw new TrukiBridgeError('INVALID_INPUT', 'invalid media params');
  }
  const { path } = await request<{ path: string }>('media.path', { mediaId });
  const source =
    typeof path === 'string'
      ? resolveTrukiMediaPath(mediaDir, path)
      : undefined;
  if (!source) {
    throw new TrukiBridgeError('NOT_FOUND', 'media file not found');
  }
  const options = { defaultPath: sanitizeTrukiSaveName(suggestedName) };
  const result = parent
    ? await showSaveDialog(parent, options)
    : await showSaveDialog(options);
  if (result.canceled || !result.filePath) {
    return { cancelled: true };
  }
  await fs.promises.copyFile(source, result.filePath);
  return { saved: true };
}

export function startTrukiBridgeSupervisor(
  getMainWindow: () => BrowserWindow | undefined
): TrukiBridgeSupervisor {
  const userDataPath = app.getPath('userData');
  const supervisor = new TrukiBridgeSupervisor({
    binaryPath: getTrukiBridgeBinaryPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appRoot: getAppRootDir(),
      platform: process.platform,
      arch: process.arch,
    }),
    userDataPath,
    encryptKey: plain => Buffer.from(safeStorage.encryptString(plain)),
    decryptKey: enc => safeStorage.decryptString(enc),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    onEvent: e => {
      getMainWindow()?.webContents.send('truki-bridge:event', e);
    },
    onStateChange: state => {
      getMainWindow()?.webContents.send('truki-bridge:event', {
        method: 'event.supervisorState',
        params: { state },
      });
    },
    getParentWindow: getMainWindow,
  });
  supervisor.emitState();

  ipcMain.handle(
    'truki-bridge:request',
    async (_event, method: unknown, params: unknown) =>
      toTrukiBridgeIpcResult(async () =>
        handleTrukiBridgeIpcRequest(supervisor, method, params)
      )
  );
  ipcMain.handle(
    'truki-bridge:set-enabled-networks',
    async (_event, ids: unknown) =>
      toTrukiBridgeIpcResult(async () => {
        await supervisor.setEnabledNetworks(ids as ReadonlyArray<string>);
      })
  );

  ipcMain.handle('truki-bridge:restart', async () =>
    toTrukiBridgeIpcResult(async () => {
      await supervisor.restart();
    })
  );
  ipcMain.handle('truki-bridge:get-state', async () =>
    toTrukiBridgeIpcResult(async () => getTrukiBridgeState(supervisor))
  );
  ipcMain.handle(
    'truki-bridge:pick-attachment',
    async (_event, params: unknown) =>
      toTrukiBridgeIpcResult(async () =>
        supervisor.pickAttachment(params as TrukiPickAttachmentParams)
      )
  );
  ipcMain.handle('truki-bridge:cookie-login', async (_event, params: unknown) =>
    toTrukiBridgeIpcResult(async () =>
      supervisor.cookieLogin(params as TrukiCookieLoginParams)
    )
  );
  ipcMain.handle('truki-bridge:save-media', async (_event, params: unknown) =>
    toTrukiBridgeIpcResult(async () =>
      supervisor.saveMedia(params as TrukiSaveMediaParams)
    )
  );

  // truki-media://<host>/<path> stands for mxc://<host>/<path>.
  const mediaDir = join(userDataPath, BRIDGE_DIR_NAME, 'media');
  protocol.handle('truki-media', async request => {
    try {
      const mediaId = trukiMediaUrlToMxc(request.url);
      if (!mediaId) {
        return new Response(null, { status: 404 });
      }
      const { path } = await supervisor.request<{ path: string }>(
        'media.path',
        { mediaId }
      );
      const safePath = resolveTrukiMediaPath(mediaDir, path);
      if (!safePath) {
        return new Response(null, { status: 404 });
      }
      return await net.fetch(pathToFileURL(safePath).toString());
    } catch (error) {
      log.warn('truki-media request failed', error);
      return new Response(null, { status: 404 });
    }
  });

  // will-quit does not wait for async work, so hold the quit until the
  // bridge has stopped, then quit again.
  let shuttingDown = false;
  app.on('will-quit', event => {
    if (!shouldDelayQuitForBridge(supervisor.state, shuttingDown)) {
      return;
    }
    shuttingDown = true;
    event.preventDefault();
    void (async () => {
      await logRejection(supervisor.shutdown(), 'bridge shutdown failed');
      app.quit();
    })();
  });

  // Bring the bridge up at launch if a network is already enabled.
  void logRejection(
    supervisor.setEnabledNetworks(supervisor.getEnabledNetworks()),
    'could not start bridge'
  );

  return supervisor;
}
