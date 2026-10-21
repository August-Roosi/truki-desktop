// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert } from 'chai';

import {
  TrukiBridgeSupervisor,
  getTrukiBridgeBinaryPath,
  resolveTrukiMediaPath,
  shouldDelayQuitForBridge,
  toTrukiBridgeIpcResult,
} from '../../../app/truki/TrukiBridgeSupervisor.main.ts';
import { TrukiBridgeError } from '../../../app/truki/trukiBridgeProtocol.std.ts';
import type { TrukiBridgeEvent } from '../../../app/truki/trukiBridgeProtocol.std.ts';

const FIXTURE = path.join(__dirname, 'fixtures', 'fakeTrukiBridge.node.mjs');

type SpawnCall = { command: string; args: ReadonlyArray<string>; env: unknown };

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

function at<T>(items: ReadonlyArray<T>, index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`no item at ${index}`);
  }
  return item;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('TrukiBridgeSupervisor', () => {
  let tmp: string;
  let supervisors: Array<TrukiBridgeSupervisor>;
  let spawnCalls: Array<SpawnCall>;
  let children: Array<ChildProcess>;
  let events: Array<TrukiBridgeEvent>;
  const timers: Array<{ fn: () => void; ms: number }> = [];

  const encryptKey = (plain: string): Buffer<ArrayBuffer> =>
    Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`);
  const decryptKey = (enc: Buffer<ArrayBuffer>): string =>
    Buffer.from(enc.toString().replace(/^enc:/, ''), 'base64').toString();

  function make({
    childEnv = {},
    encryption = true,
    fakeClock = false,
    userData = path.join(tmp, 'userData'),
  }: {
    childEnv?: Record<string, string>;
    encryption?: boolean;
    fakeClock?: boolean;
    userData?: string;
  } = {}): TrukiBridgeSupervisor {
    const spawnFn = ((
      command: string,
      args: ReadonlyArray<string>,
      options: SpawnOptions
    ) => {
      spawnCalls.push({ command, args, env: options.env });
      // ELECTRON_RUN_AS_NODE goes into the child's env only.
      const child = spawn(process.execPath, [FIXTURE], {
        ...options,
        env: {
          ...options.env,
          ELECTRON_RUN_AS_NODE: '1',
          FAKE_TRUKI_BRIDGE: '1',
          ...childEnv,
        },
      });
      children.push(child);
      return child;
    }) as unknown as typeof spawn;

    const supervisor = new TrukiBridgeSupervisor({
      binaryPath: '/does/not/matter/truki-bridge',
      userDataPath: userData,
      encryptKey,
      decryptKey,
      isEncryptionAvailable: () => encryption,
      onEvent: e => events.push(e),
      spawnFn,
      ...(fakeClock
        ? {
            setTimeoutFn: ((fn: () => void, ms: number) => {
              timers.push({ fn, ms });
              return undefined;
            }) as unknown as typeof setTimeout,
          }
        : {}),
    });
    supervisors.push(supervisor);
    return supervisor;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'truki-supervisor-'));
    supervisors = [];
    spawnCalls = [];
    children = [];
    events = [];
    timers.length = 0;
  });

  afterEach(async () => {
    await Promise.all(supervisors.map(s => s.shutdown()));
    for (const child of children) {
      child.kill('SIGKILL');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does not start with no networks enabled', async () => {
    const supervisor = make();
    assert.strictEqual(spawnCalls.length, 0);
    const error = await rejection(supervisor.request('echo', {}));
    assert.strictEqual((error as { code: string }).code, 'BRIDGE_UNAVAILABLE');
    assert.strictEqual(spawnCalls.length, 0);
    assert.strictEqual(supervisor.state, 'stopped');
  });

  it('starts, handshakes, and answers requests', async () => {
    const supervisor = make();
    await supervisor.setEnabledNetworks(['signal']);
    assert.deepEqual(await supervisor.request('echo', { a: 1 }), { a: 1 });
    assert.strictEqual(supervisor.state, 'running');
    assert.deepEqual(supervisor.getEnabledNetworks(), ['signal']);
  });

  it('persists the enabled networks', async () => {
    const first = make();
    await first.setEnabledNetworks(['signal', 'whatsapp']);
    const second = make();
    assert.deepEqual(second.getEnabledNetworks(), ['signal', 'whatsapp']);
  });

  it('matches out-of-order responses by id', async () => {
    const supervisor = make();
    await supervisor.setEnabledNetworks(['signal']);
    const order: Array<string> = [];
    const echoLater = async (ms: number, value: string) => {
      const result = await supervisor.request('echoLater', { ms, value });
      order.push(String(result));
      return result;
    };
    const slow = echoLater(300, 'slow');
    const fast = echoLater(0, 'fast');
    assert.deepEqual(await Promise.all([slow, fast]), ['slow', 'fast']);
    assert.deepEqual(order, ['fast', 'slow']);
  });

  it('passes the key only via init', async () => {
    const keyOut = path.join(tmp, 'key-out');
    const userData = path.join(tmp, 'userData');
    const supervisor = make({ childEnv: { FAKE_KEY_OUT: keyOut } });
    await supervisor.setEnabledNetworks(['signal']);
    await supervisor.request('echo', {});

    const hex = fs.readFileSync(keyOut, 'utf8');
    assert.match(hex, /^[0-9a-f]{64}$/);

    const call = at(spawnCalls, 0);
    assert.notInclude(JSON.stringify(call.args), hex);
    for (const value of Object.values(call.env as Record<string, unknown>)) {
      assert.notInclude(String(value), hex);
    }

    const stored = fs.readFileSync(
      path.join(userData, 'truki-bridge', 'truki-bridge.key')
    );
    assert.notInclude(stored.toString('latin1'), hex);
    assert.strictEqual(decryptKey(stored), hex);
  });

  it('reuses the stored key across restarts', async () => {
    const keyOut1 = path.join(tmp, 'key-out-1');
    const keyOut2 = path.join(tmp, 'key-out-2');
    const first = make({ childEnv: { FAKE_KEY_OUT: keyOut1 } });
    await first.setEnabledNetworks(['signal']);
    await first.request('echo', {});
    await first.shutdown();

    const second = make({ childEnv: { FAKE_KEY_OUT: keyOut2 } });
    await second.setEnabledNetworks(['signal']);
    await second.request('echo', {});

    assert.strictEqual(
      fs.readFileSync(keyOut1, 'utf8'),
      fs.readFileSync(keyOut2, 'utf8')
    );
  });

  it('refuses to start without encryption', async () => {
    const supervisor = make({ encryption: false });
    await supervisor.setEnabledNetworks(['signal']);
    const error = await rejection(supervisor.request('echo', {}));
    assert.strictEqual((error as { code: string }).code, 'BRIDGE_UNAVAILABLE');
    assert.strictEqual(spawnCalls.length, 0);
    assert.isFalse(
      fs.existsSync(
        path.join(tmp, 'userData', 'truki-bridge', 'truki-bridge.key')
      )
    );
  });

  it('forwards events', async () => {
    const supervisor = make();
    await supervisor.setEnabledNetworks(['signal']);
    await supervisor.request('emit');
    await waitFor(() => events.length > 0, 'event');
    assert.deepEqual(events, [{ method: 'event.test', params: { n: 1 } }]);
  });

  it('forwards events that arrive before the init response', async () => {
    const supervisor = make({ childEnv: { FAKE_EVENT_BEFORE_INIT: '1' } });
    await supervisor.setEnabledNetworks(['signal']);
    await supervisor.request('echo', {});
    assert.deepEqual(events, [{ method: 'event.early', params: { n: 0 } }]);
  });

  it('fails in-flight requests on crash', async () => {
    const supervisor = make({ fakeClock: true });
    await supervisor.setEnabledNetworks(['signal']);
    await supervisor.request('echo', {});
    const hanging = supervisor.request('hang');
    const crashing = supervisor.request('crash');
    const hangError = await rejection(hanging);
    assert.strictEqual(
      (hangError as { code: string }).code,
      'BRIDGE_UNAVAILABLE'
    );
    await rejection(crashing);
    assert.strictEqual(supervisor.state, 'backoff');
  });

  it('backs off 1s, 2s, 4s and gives up after 5 crashes in 10 minutes', async () => {
    const supervisor = make({
      fakeClock: true,
      childEnv: { FAKE_CRASH_ON_START: '1' },
    });
    await supervisor.setEnabledNetworks(['signal']);

    for (let i = 0; i < 4; i += 1) {
      const expected = i + 1;
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => timers.length === expected, `backoff ${expected}`);
      at(timers, i).fn();
    }
    await waitFor(() => supervisor.state === 'gave-up', 'gave-up');

    assert.deepEqual(
      timers.map(t => t.ms),
      [1000, 2000, 4000, 8000]
    );
    assert.strictEqual(spawnCalls.length, 5);
    const error = await rejection(supervisor.request('echo', {}));
    assert.strictEqual((error as { code: string }).code, 'BRIDGE_STOPPED');
  });

  it('rejects incompatible protocol', async () => {
    const supervisor = make({
      fakeClock: true,
      childEnv: { FAKE_PROTOCOL: '2' },
    });
    await supervisor.setEnabledNetworks(['signal']);
    const error = await rejection(supervisor.request('echo', {}));
    assert.strictEqual((error as { code: string }).code, 'BRIDGE_INCOMPATIBLE');
    const child = at(children, 0);
    await waitFor(
      () => child.exitCode != null || child.signalCode != null,
      'child exit'
    );
    assert.strictEqual(timers.length, 0);
    assert.strictEqual(spawnCalls.length, 1);
    const again = await rejection(supervisor.request('echo', {}));
    assert.strictEqual((again as { code: string }).code, 'BRIDGE_INCOMPATIBLE');
  });

  it('shuts down cleanly when the bridge answers shutdown', async () => {
    const supervisor = make();
    await supervisor.setEnabledNetworks(['signal']);
    await supervisor.request('echo', {});
    await supervisor.shutdown();
    assert.strictEqual(supervisor.state, 'stopped');
    assert.strictEqual(at(children, 0).exitCode, 0);
  });

  it('shutdown sends shutdown and kills after 5s', async () => {
    const supervisor = make({
      fakeClock: true,
      childEnv: { FAKE_HANG_SHUTDOWN: '1' },
    });
    await supervisor.setEnabledNetworks(['signal']);
    await supervisor.request('echo', {});

    const done = supervisor.shutdown();
    await waitFor(() => timers.some(t => t.ms === 5000), '5s kill timer');
    assert.isNull(at(children, 0).exitCode);
    assert.isNull(at(children, 0).signalCode);

    timers.find(t => t.ms === 5000)?.fn();
    await done;
    assert.strictEqual(at(children, 0).signalCode, 'SIGKILL');
    assert.strictEqual(supervisor.state, 'stopped');
  });

  it('reserves init and shutdown for the supervisor', async () => {
    const supervisor = make();
    await supervisor.setEnabledNetworks(['signal']);
    await supervisor.request('echo', {});

    for (const [method, params] of [
      ['shutdown', undefined],
      ['init', { protocolVersion: 1, dataDir: '/x', dbKey: 'y' }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const error = await rejection(supervisor.request(method, params));
      assert.strictEqual((error as { code: string }).code, 'INVALID_INPUT');
    }

    assert.strictEqual(supervisor.state, 'running');
    assert.strictEqual(spawnCalls.length, 1);
    assert.deepEqual(await supervisor.request('echo', { still: 'up' }), {
      still: 'up',
    });
  });

  describe('toTrukiBridgeIpcResult', () => {
    it('wraps success, bridge errors and unexpected errors', async () => {
      assert.deepEqual(await toTrukiBridgeIpcResult(async () => 5), {
        ok: true,
        value: 5,
      });
      assert.deepEqual(
        await toTrukiBridgeIpcResult(async () => {
          throw new TrukiBridgeError('NOT_FOUND', 'nope');
        }),
        { ok: false, code: 'NOT_FOUND', message: 'nope' }
      );
      assert.deepEqual(
        await toTrukiBridgeIpcResult(async () => {
          throw new TrukiBridgeError('INTERNAL', 'failed', 'LOGIN_FAILED');
        }),
        {
          ok: false,
          code: 'INTERNAL',
          bridgeCode: 'LOGIN_FAILED',
          message: 'failed',
        }
      );
      assert.deepEqual(
        await toTrukiBridgeIpcResult(async () => {
          throw new Error('secret detail');
        }),
        { ok: false, code: 'INTERNAL', message: 'internal error' }
      );
    });
  });

  describe('shouldDelayQuitForBridge', () => {
    it('delays quit once while the bridge may be alive', () => {
      assert.isTrue(shouldDelayQuitForBridge('running', false));
      assert.isTrue(shouldDelayQuitForBridge('starting', false));
      assert.isTrue(shouldDelayQuitForBridge('backoff', false));
      assert.isFalse(shouldDelayQuitForBridge('running', true));
      assert.isFalse(shouldDelayQuitForBridge('stopped', false));
      assert.isFalse(shouldDelayQuitForBridge('gave-up', false));
    });
  });

  describe('getTrukiBridgeBinaryPath', () => {
    it('maps node platform names to the Go dist directory', () => {
      const dev = (platform: NodeJS.Platform, arch: string) =>
        getTrukiBridgeBinaryPath({
          isPackaged: false,
          resourcesPath: '/res',
          appRoot: '/app',
          platform,
          arch,
        });
      assert.strictEqual(
        dev('win32', 'x64'),
        path.join(
          '/app',
          'truki-bridge',
          'dist',
          'windows-amd64',
          'truki-bridge.exe'
        )
      );
      assert.strictEqual(
        dev('darwin', 'arm64'),
        path.join(
          '/app',
          'truki-bridge',
          'dist',
          'darwin-arm64',
          'truki-bridge'
        )
      );
      assert.strictEqual(
        dev('linux', 'x64'),
        path.join('/app', 'truki-bridge', 'dist', 'linux-amd64', 'truki-bridge')
      );
      assert.strictEqual(
        getTrukiBridgeBinaryPath({
          isPackaged: true,
          resourcesPath: '/res',
          appRoot: '/app',
          platform: 'win32',
          arch: 'x64',
        }),
        path.join('/res', 'truki-bridge.exe')
      );
    });
  });

  describe('resolveTrukiMediaPath', () => {
    it('accepts files inside the media dir and rejects everything else', () => {
      const mediaDir = path.join(tmp, 'media');
      fs.mkdirSync(mediaDir);
      const inside = path.join(mediaDir, 'abc');
      fs.writeFileSync(inside, 'x');
      const outside = path.join(tmp, 'secret');
      fs.writeFileSync(outside, 'x');
      fs.symlinkSync(outside, path.join(mediaDir, 'link'));

      assert.strictEqual(
        resolveTrukiMediaPath(mediaDir, inside),
        fs.realpathSync(inside)
      );
      assert.isUndefined(resolveTrukiMediaPath(mediaDir, outside));
      assert.isUndefined(
        resolveTrukiMediaPath(mediaDir, path.join(mediaDir, '..', 'secret'))
      );
      assert.isUndefined(
        resolveTrukiMediaPath(mediaDir, path.join(mediaDir, 'link'))
      );
      assert.isUndefined(
        resolveTrukiMediaPath(mediaDir, path.join(mediaDir, 'missing'))
      );
    });
  });
});
