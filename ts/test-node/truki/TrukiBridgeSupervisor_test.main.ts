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
  getTrukiBridgeState,
  handleTrukiBridgeIpcRequest,
  resolveTrukiMediaPath,
  sanitizeTrukiSaveName,
  saveTrukiMedia,
  shouldDelayQuitForBridge,
  toTrukiBridgeIpcResult,
} from '../../../app/truki/TrukiBridgeSupervisor.main.ts';
import {
  TrukiBridgeError,
  mxcToTrukiMediaUrl,
  trukiMediaUrlToMxc,
} from '../../../app/truki/trukiBridgeProtocol.std.ts';
import type { TrukiBridgeSupervisorOptions } from '../../../app/truki/TrukiBridgeSupervisor.main.ts';
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
  let states: Array<string>;
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
    showOpenDialog,
  }: {
    childEnv?: Record<string, string>;
    encryption?: boolean;
    fakeClock?: boolean;
    userData?: string;
    showOpenDialog?: TrukiBridgeSupervisorOptions['showOpenDialog'];
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
      onStateChange: state => states.push(state),
      ...(showOpenDialog ? { showOpenDialog } : {}),
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
    states = [];
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

  it('ignores JSON lines that are not objects', async () => {
    const supervisor = make();
    await supervisor.setEnabledNetworks(['signal']);
    await supervisor.request('junk');
    assert.deepEqual(await supervisor.request('echo', { after: 'junk' }), {
      after: 'junk',
    });
    assert.strictEqual(supervisor.state, 'running');
    assert.strictEqual(spawnCalls.length, 1);
  });

  describe('supervisor state events', () => {
    it('reports stopped, starting, running', async () => {
      const supervisor = make();
      supervisor.emitState();
      assert.deepEqual(states, ['stopped']);
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.request('echo', {});
      assert.deepEqual(states, ['stopped', 'starting', 'running']);
    });

    it('reports backoff after a crash', async () => {
      const supervisor = make({ fakeClock: true });
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.request('echo', {});
      await rejection(supervisor.request('crash'));
      assert.deepEqual(states, ['stopped', 'starting', 'running', 'backoff']);
    });

    it('reports unavailable when secure storage is missing', async () => {
      const supervisor = make({ encryption: false });
      supervisor.emitState();
      await supervisor.setEnabledNetworks(['signal']);
      assert.deepEqual(states, ['unavailable']);
      assert.strictEqual(spawnCalls.length, 0);
    });
  });

  describe('restart', () => {
    async function giveUp(supervisor: TrukiBridgeSupervisor): Promise<void> {
      await supervisor.setEnabledNetworks(['signal']);
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await waitFor(() => timers.length === i + 1, `backoff ${i + 1}`);
        at(timers, i).fn();
      }
      await waitFor(() => supervisor.state === 'gave-up', 'gave-up');
    }

    it('spawns again from gave-up and reports the transitions', async () => {
      const supervisor = make({
        fakeClock: true,
        childEnv: { FAKE_CRASH_ON_START: '1' },
      });
      await giveUp(supervisor);
      assert.strictEqual(spawnCalls.length, 5);
      states.length = 0;

      await supervisor.restart();
      assert.strictEqual(spawnCalls.length, 6);
      assert.deepEqual(states.slice(0, 2), ['stopped', 'starting']);
      assert.notInclude(states, 'gave-up');
    });

    it('resets the crash counter', async () => {
      const supervisor = make({
        fakeClock: true,
        childEnv: { FAKE_CRASH_ON_START: '1' },
      });
      await giveUp(supervisor);
      await supervisor.restart();
      // One crash after the restart is a first crash again: backoff, not
      // gave-up.
      await waitFor(() => supervisor.state === 'backoff', 'backoff');
      assert.strictEqual(timers[timers.length - 1]?.ms, 1000);
    });

    it('stops a running bridge and starts a new one', async () => {
      const supervisor = make();
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.request('echo', {});
      await supervisor.restart();
      await supervisor.request('echo', {});
      assert.strictEqual(spawnCalls.length, 2);
      assert.strictEqual(supervisor.state, 'running');
      assert.deepEqual(states, [
        'stopped',
        'starting',
        'running',
        'stopped',
        'starting',
        'running',
      ]);
    });

    const isGone = (c: ChildProcess | undefined): boolean =>
      c == null || c.exitCode != null || c.signalCode != null;
    const alive = (): number => children.filter(c => !isGone(c)).length;

    it('two restarts without awaiting spawn one new bridge', async () => {
      const supervisor = make();
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.request('echo', {});
      const first = children[0];
      await Promise.all([supervisor.restart(), supervisor.restart()]);
      await supervisor.request('echo', {});
      assert.strictEqual(spawnCalls.length, 2);
      await waitFor(() => isGone(first), 'old child exit');
      assert.strictEqual(alive(), 1);
    });

    it('restart racing setEnabledNetworks leaves one live bridge', async () => {
      const supervisor = make();
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.request('echo', {});
      await Promise.all([
        supervisor.restart(),
        supervisor.setEnabledNetworks(['x']),
      ]);
      await supervisor.request('echo', {});
      assert.strictEqual(supervisor.state, 'running');
      assert.strictEqual(alive(), 1);
    });

    it('restart queued behind shutdown does not spawn', async () => {
      const supervisor = make();
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.request('echo', {});
      const restarting = supervisor.restart();
      const shuttingDown = supervisor.shutdown();
      await Promise.all([restarting, shuttingDown]);
      assert.strictEqual(alive(), 0);
      assert.strictEqual(supervisor.state, 'stopped');
      const error = await rejection(supervisor.restart());
      assert.strictEqual((error as { code: string }).code, 'BRIDGE_STOPPED');
      assert.strictEqual(spawnCalls.length, 1);
    });

    it('stays stopped when no network is enabled', async () => {
      const supervisor = make();
      await supervisor.restart();
      assert.strictEqual(spawnCalls.length, 0);
      assert.strictEqual(supervisor.state, 'stopped');
    });

    it('does not start without secure storage', async () => {
      const supervisor = make({ encryption: false });
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.restart();
      assert.strictEqual(spawnCalls.length, 0);
    });
  });

  describe('key file', () => {
    const keyPath = (): string =>
      path.join(tmp, 'userData', 'truki-bridge', 'truki-bridge.key');

    it('leaves no .tmp file after creating the key', async () => {
      const supervisor = make();
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.request('echo', {});
      assert.isTrue(fs.existsSync(keyPath()));
      assert.isFalse(fs.existsSync(`${keyPath()}.tmp`));
    });

    it('keeps the old key when a crash left a .tmp behind', async () => {
      const keyOut1 = path.join(tmp, 'key-out-1');
      const keyOut2 = path.join(tmp, 'key-out-2');
      const first = make({ childEnv: { FAKE_KEY_OUT: keyOut1 } });
      await first.setEnabledNetworks(['signal']);
      await first.request('echo', {});
      await first.shutdown();
      const before = fs.readFileSync(keyPath());

      // A crash between writing the .tmp and renaming it.
      fs.writeFileSync(`${keyPath()}.tmp`, 'half-written garbage');

      const second = make({ childEnv: { FAKE_KEY_OUT: keyOut2 } });
      await second.setEnabledNetworks(['signal']);
      await second.request('echo', {});
      assert.deepEqual(fs.readFileSync(keyPath()), before);
      assert.strictEqual(
        fs.readFileSync(keyOut1, 'utf8'),
        fs.readFileSync(keyOut2, 'utf8')
      );
    });

    it('overwrites a leftover .tmp when there is no key yet', async () => {
      fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
      fs.writeFileSync(`${keyPath()}.tmp`, 'half-written garbage');
      const supervisor = make();
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.request('echo', {});
      assert.match(decryptKey(fs.readFileSync(keyPath())), /^[0-9a-f]{64}$/);
      assert.isFalse(fs.existsSync(`${keyPath()}.tmp`));
    });
  });

  describe('getTrukiBridgeState', () => {
    it('reports unavailable, stopped and running', async () => {
      assert.strictEqual(
        getTrukiBridgeState(make({ encryption: false })),
        'unavailable'
      );
      const supervisor = make();
      assert.strictEqual(getTrukiBridgeState(supervisor), 'stopped');
      await supervisor.setEnabledNetworks(['signal']);
      await supervisor.request('echo', {});
      assert.strictEqual(getTrukiBridgeState(supervisor), 'running');
    });
  });

  describe('media URLs', () => {
    const hex = 'ab'.repeat(32);

    it('round-trips mxc and truki-media URLs', () => {
      const url = `truki-media://truki.local/${hex}`;
      assert.strictEqual(mxcToTrukiMediaUrl(`mxc://truki.local/${hex}`), url);
      assert.strictEqual(trukiMediaUrlToMxc(url), `mxc://truki.local/${hex}`);
    });

    it('normalises an uppercase host', () => {
      assert.strictEqual(
        mxcToTrukiMediaUrl(`mxc://TRUKI.Local/${hex}`),
        `truki-media://truki.local/${hex}`
      );
      assert.strictEqual(
        trukiMediaUrlToMxc(`truki-media://TRUKI.LOCAL/${hex}`),
        `mxc://truki.local/${hex}`
      );
    });

    it('rejects other hosts, non-hex ids and traversal', () => {
      for (const bad of [
        `mxc://evil.example/${hex}`,
        `mxc://truki.local/${'zz'.repeat(32)}`,
        `mxc://truki.local/${hex.slice(2)}`,
        `mxc://truki.local/../${hex}`,
        `mxc://truki.local/${hex}/..`,
        `mxc://truki.local/${hex}?x=1`,
        `http://truki.local/${hex}`,
        '',
      ]) {
        assert.isUndefined(mxcToTrukiMediaUrl(bad), bad);
      }
      for (const bad of [
        `truki-media://evil.example/${hex}`,
        `truki-media://truki.local/${'zz'.repeat(32)}`,
        `truki-media://truki.local/../${hex}`,
        `truki-media://truki.local/%2e%2e/${hex}`,
        `truki-media://truki.local/${hex}#frag`,
        `https://truki.local/${hex}`,
        '',
      ]) {
        assert.isUndefined(trukiMediaUrlToMxc(bad), bad);
      }
    });
  });

  describe('pickAttachment', () => {
    it('returns cancelled without touching the bridge', async () => {
      const supervisor = make({
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      });
      // No network is enabled, so any bridge request would be refused.
      assert.deepEqual(await supervisor.pickAttachment({ chatId: 'c' }), {
        cancelled: true,
      });
      assert.strictEqual(spawnCalls.length, 0);
    });

    it('sends the main-issued path to the bridge', async () => {
      const file = path.join(tmp, 'photo.png');
      fs.writeFileSync(file, 'x');
      const supervisor = make({
        showOpenDialog: async () => ({ canceled: false, filePaths: [file] }),
      });
      await supervisor.setEnabledNetworks(['signal']);
      // The fake bridge echoes messages.send params.
      const result = (await supervisor.pickAttachment({
        chatId: 'c',
        caption: 'hi',
        replyTo: '$e',
      })) as unknown;
      assert.deepEqual(result, {
        chatId: 'c',
        text: 'hi',
        replyTo: '$e',
        attachments: [{ path: file, name: 'photo.png' }],
      });
    });

    it('rejects malformed params', async () => {
      const supervisor = make({
        showOpenDialog: async () => {
          throw new Error('dialog must not open');
        },
      });
      const error = await rejection(supervisor.pickAttachment({ chatId: '' }));
      assert.strictEqual((error as TrukiBridgeError).code, 'INVALID_INPUT');
    });
  });

  describe('saveTrukiMedia', () => {
    const HASH = 'c'.repeat(64);
    const MXC = `mxc://truki.local/${HASH}`;
    let mediaDir: string;
    let outDir: string;
    let requests: Array<{ method: string; params: unknown }>;
    let dialogOptions: Array<unknown>;

    function deps(
      choose: string | undefined,
      mediaPath = path.join(mediaDir, HASH)
    ) {
      return {
        mediaDir,
        parent: undefined,
        request: async <T>(method: string, params: unknown): Promise<T> => {
          requests.push({ method, params });
          return { path: mediaPath } as T;
        },
        showSaveDialog: (async (options: unknown) => {
          dialogOptions.push(options);
          return choose === undefined
            ? { canceled: true, filePath: '' }
            : { canceled: false, filePath: choose };
        }) as unknown as Parameters<typeof saveTrukiMedia>[1]['showSaveDialog'],
      };
    }

    beforeEach(() => {
      mediaDir = path.join(tmp, 'userData', 'truki-bridge', 'media');
      outDir = path.join(tmp, 'out');
      fs.mkdirSync(mediaDir, { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(mediaDir, HASH), 'media bytes');
      requests = [];
      dialogOptions = [];
    });

    it('cancel copies nothing', async () => {
      assert.deepEqual(
        await saveTrukiMedia(
          { mxc: MXC, suggestedName: 'a.pdf' },
          deps(undefined)
        ),
        { cancelled: true }
      );
      assert.deepEqual(fs.readdirSync(outDir), []);
    });

    it('copies the media file to the chosen path', async () => {
      const target = path.join(outDir, 'report.pdf');
      assert.deepEqual(
        await saveTrukiMedia(
          { mxc: MXC, suggestedName: 'report.pdf' },
          deps(target)
        ),
        { saved: true }
      );
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'media bytes');
      assert.deepEqual(requests, [
        { method: 'media.path', params: { mediaId: MXC } },
      ]);
      assert.deepEqual(dialogOptions, [{ defaultPath: 'report.pdf' }]);
    });

    it('rejects a crafted mxc without asking the bridge', async () => {
      for (const mxc of [
        'mxc://evil.org/abc',
        `mxc://truki.local/../${HASH}`,
        '/etc/passwd',
        42,
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const error = await rejection(
          saveTrukiMedia(
            { mxc } as unknown as { mxc: string },
            deps(path.join(outDir, 'x'))
          )
        );
        assert.strictEqual((error as TrukiBridgeError).code, 'INVALID_INPUT');
      }
      assert.deepEqual(requests, []);
      assert.deepEqual(fs.readdirSync(outDir), []);
    });

    it('refuses a bridge path outside the media directory', async () => {
      const outside = path.join(tmp, 'secret.txt');
      fs.writeFileSync(outside, 'secret');
      const error = await rejection(
        saveTrukiMedia({ mxc: MXC }, deps(path.join(outDir, 'x'), outside))
      );
      assert.strictEqual((error as TrukiBridgeError).code, 'NOT_FOUND');
      assert.deepEqual(dialogOptions, []);
      assert.deepEqual(fs.readdirSync(outDir), []);
    });

    it('offers only a plain file name from a crafted name', async () => {
      const target = path.join(outDir, 'chosen.bin');
      await saveTrukiMedia(
        { mxc: MXC, suggestedName: '../../etc/passwd' },
        deps(target)
      );
      assert.deepEqual(dialogOptions, [{ defaultPath: 'passwd' }]);
      assert.deepEqual(fs.readdirSync(outDir), ['chosen.bin']);
      assert.isFalse(fs.existsSync(path.join(tmp, 'etc')));
    });

    it('sanitizes names', () => {
      assert.strictEqual(sanitizeTrukiSaveName('..\\..\\win.ini'), 'win.ini');
      assert.strictEqual(sanitizeTrukiSaveName('a\u0000b.txt'), 'ab.txt');
      assert.strictEqual(sanitizeTrukiSaveName('..'), 'file');
      assert.strictEqual(sanitizeTrukiSaveName(''), 'file');
      assert.strictEqual(sanitizeTrukiSaveName(undefined), 'file');
      assert.lengthOf(sanitizeTrukiSaveName('x'.repeat(500)), 200);
    });
  });

  describe('handleTrukiBridgeIpcRequest', () => {
    const attachments = [{ path: '/etc/passwd', mimeType: 'text/plain' }];

    it('refuses messages.send with attachments from the renderer', async () => {
      const supervisor = make();
      await supervisor.setEnabledNetworks(['signal']);
      const error = await rejection(
        handleTrukiBridgeIpcRequest(supervisor, 'messages.send', {
          chatId: 'c',
          text: 'hi',
          attachments,
        })
      );
      assert.instanceOf(error, TrukiBridgeError);
      assert.strictEqual(error.code, 'INVALID_INPUT');
      assert.include(
        error.message,
        'attachments over IPC are not supported yet'
      );

      // Nothing reaches the bridge, whatever form the attachments take.
      const forwarded: Array<string> = [];
      const stub = {
        request: async <T>(method: string): Promise<T> => {
          forwarded.push(method);
          return undefined as T;
        },
      };
      for (const bad of [attachments, 'x', { path: '/etc/passwd' }]) {
        // eslint-disable-next-line no-await-in-loop
        const refused = await rejection(
          handleTrukiBridgeIpcRequest(stub, 'messages.send', {
            chatId: 'c',
            attachments: bad,
          })
        );
        assert.strictEqual((refused as TrukiBridgeError).code, 'INVALID_INPUT');
      }
      assert.deepEqual(forwarded, []);
    });

    it('forwards messages.send without attachments', async () => {
      const supervisor = make();
      await supervisor.setEnabledNetworks(['signal']);
      for (const params of [
        { chatId: 'c', text: 'hi' },
        { chatId: 'c', text: 'hi', attachments: [] },
      ]) {
        assert.deepEqual(
          // eslint-disable-next-line no-await-in-loop
          await handleTrukiBridgeIpcRequest(
            supervisor,
            'messages.send',
            params
          ),
          params
        );
      }
    });

    it('rejects a non-string method', async () => {
      const supervisor = make();
      const error = await rejection(
        handleTrukiBridgeIpcRequest(supervisor, 42, {})
      );
      assert.strictEqual((error as TrukiBridgeError).code, 'INVALID_INPUT');
    });

    it('lets main-process callers send attachments', async () => {
      const supervisor = make();
      await supervisor.setEnabledNetworks(['signal']);
      const params = { chatId: 'c', text: 'hi', attachments };
      assert.deepEqual(
        await supervisor.request('messages.send', params),
        params
      );
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
