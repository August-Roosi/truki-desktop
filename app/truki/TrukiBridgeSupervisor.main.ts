// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { app, ipcMain, net, protocol, safeStorage } from 'electron';
import type { BrowserWindow } from 'electron';

import { createLogger } from '../../ts/logging/log.std.ts';
import { getAppRootDir } from '../../ts/util/appRootDir.main.ts';
import {
  TRUKI_BRIDGE_PROTOCOL_VERSION,
  TrukiBridgeError,
  isTrukiBridgeErrorCode,
} from './trukiBridgeProtocol.std.ts';
import type {
  TrukiBridgeEvent,
  TrukiBridgeIpcResult,
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
  // Test seams
  spawnFn?: typeof spawn;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
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

  constructor(opts: TrukiBridgeSupervisorOptions) {
    this.#opts = opts;
    this.#bridgeDir = join(opts.userDataPath, BRIDGE_DIR_NAME);
    this.#enabledNetworks = this.#loadSettings();
  }

  get state(): TrukiBridgeSupervisorState {
    return this.#state;
  }

  getEnabledNetworks(): ReadonlyArray<string> {
    return this.#enabledNetworks;
  }

  async setEnabledNetworks(ids: ReadonlyArray<string>): Promise<void> {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
      throw new TrukiBridgeError('INVALID_INPUT', 'ids must be strings');
    }
    this.#enabledNetworks = [...ids];
    fs.mkdirSync(this.#bridgeDir, { recursive: true });
    fs.writeFileSync(
      join(this.#bridgeDir, SETTINGS_FILE_NAME),
      JSON.stringify({ enabledNetworks: this.#enabledNetworks })
    );

    if (this.#enabledNetworks.length === 0) {
      await this.#stop();
      return;
    }
    if (this.#canStart() && this.#state === 'stopped') {
      this.#start();
    }
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
    return (await this.#send(run, method, params)) as T;
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.#stop();
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
    fs.writeFileSync(keyPath, this.#opts.encryptKey(hex), { mode: 0o600 });
    return hex;
  }

  #start(): void {
    this.#state = 'starting';
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
      this.#state = 'gave-up';
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
        this.#state = 'gave-up';
        run.stopping = true;
      }
      if (!run.closed) {
        run.child.kill();
      }
      throw failure;
    }
    if (this.#run === run && !run.stopping && !run.closed) {
      this.#state = 'running';
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
      this.#state = 'gave-up';
      return;
    }
    const delay = BACKOFF_BASE_MS * 2 ** (this.#crashTimes.length - 1);
    this.#state = 'backoff';
    const timeoutFn = this.#opts.setTimeoutFn ?? setTimeout;
    this.#restartTimer = timeoutFn(() => {
      this.#restartTimer = undefined;
      if (this.#state === 'backoff' && this.#canStart()) {
        this.#start();
      }
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
      this.#state = 'stopped';
    }
  }
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
  });

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

  // truki-media://<host>/<path> stands for mxc://<host>/<path>.
  const mediaDir = join(userDataPath, BRIDGE_DIR_NAME, 'media');
  protocol.handle('truki-media', async request => {
    try {
      const url = new URL(request.url);
      const mediaId = `mxc://${url.host}${url.pathname}`;
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
