// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  actions,
  getEmptyState,
  loginStarted,
  messagesLoaded,
  messagesLoading,
  reducer,
  setTrukiBridgeClientForTesting,
  trukiBridgeEventApplied,
} from '../../state/ducks/trukiBridge.preload.ts';
import type {
  TrukiBridgeAction,
  TrukiBridgeClient,
  TrukiBridgedChatSummary,
  TrukiBridgeStateType,
} from '../../state/ducks/trukiBridge.preload.ts';
import type { StateType } from '../../state/reducer.preload.ts';
import type {
  TrukiBridgeEvent,
  TrukiBridgeIpcResult,
  TrukiSupervisorStateName,
} from '../../../app/truki/trukiBridgeProtocol.std.ts';

const CHAT_A = '!a:truki.local';
const CHAT_B = '!b:truki.local';
const ME = '@me:truki.local';
const THEM = '@whatsapp_1:truki.local';

function wireChat(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    network: 'whatsapp',
    loginId: 'login1',
    name: `Chat ${id}`,
    topic: '',
    isDm: true,
    unreadCount: 0,
    lastActivity: '2026-10-21T10:00:00Z',
    ...overrides,
  };
}

function wireEvent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    chatId: CHAT_A,
    sender: THEM,
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: `body of ${id}` },
    timestamp: '2026-10-21T11:00:00Z',
    streamOrder: 1,
    ...overrides,
  };
}

function ev(method: string, params: unknown): TrukiBridgeEvent {
  return { method: method as `event.${string}`, params };
}

function apply(
  state: TrukiBridgeStateType,
  method: string,
  params: unknown,
  receivedAt = 0
): TrukiBridgeStateType {
  return reducer(
    state,
    trukiBridgeEventApplied(ev(method, params), receivedAt)
  );
}

function withChats(...ids: Array<string>): TrukiBridgeStateType {
  let state = getEmptyState();
  for (const id of ids) {
    state = apply(state, 'event.chat', wireChat(id));
  }
  return state;
}

function chatOf(
  state: TrukiBridgeStateType,
  id: string
): TrukiBridgedChatSummary {
  const chat = state.chats[id];
  if (!chat) {
    throw new Error(`no chat ${id}`);
  }
  return chat;
}

function messagesOf(
  state: TrukiBridgeStateType,
  id: string
): TrukiBridgeStateType['messagesByChat'][string] {
  const entry = state.messagesByChat[id];
  if (!entry) {
    throw new Error(`no messages for ${id}`);
  }
  return entry;
}

function eventIds(state: TrukiBridgeStateType, id: string): Array<string> {
  return messagesOf(state, id).events.map(e => e.id);
}

function firstEvent(state: TrukiBridgeStateType, id: string) {
  const [event] = messagesOf(state, id).events;
  if (!event) {
    throw new Error(`no events for ${id}`);
  }
  return event;
}

function loginOf(state: TrukiBridgeStateType, processId: string) {
  const process = state.loginProcesses[processId];
  if (!process) {
    throw new Error(`no login process ${processId}`);
  }
  return process;
}

function loadedChatA(): TrukiBridgeStateType {
  return reducer(
    withChats(CHAT_A),
    messagesLoaded(CHAT_A, [], 'replace', false)
  );
}

describe('trukiBridge duck', () => {
  describe('event.message', () => {
    it('updates preview, lastActivity and unread of a known chat', () => {
      const state = apply(withChats(CHAT_A), 'event.message', wireEvent('$1'));
      const chat = chatOf(state, CHAT_A);
      assert.deepEqual(chat.preview, { text: 'body of $1', fromMe: false });
      assert.strictEqual(chat.lastActivity, Date.parse('2026-10-21T11:00:00Z'));
      assert.strictEqual(chat.unreadCount, 1);
    });

    it('does not count the local user’s own message as unread', () => {
      const state = apply(
        withChats(CHAT_A),
        'event.message',
        wireEvent('$1', { sender: ME, status: 'pending' })
      );
      const chat = chatOf(state, CHAT_A);
      assert.strictEqual(chat.unreadCount, 0);
      assert.deepEqual(chat.preview, { text: 'body of $1', fromMe: true });
    });

    it('creates a placeholder for an unknown chat that sorts first', () => {
      const state = apply(
        withChats(CHAT_B),
        'event.message',
        wireEvent('$1', { chatId: CHAT_A }),
        123
      );
      const chat = chatOf(state, CHAT_A);
      assert.strictEqual(chat.name, '');
      assert.strictEqual(chat.unreadCount, 1);
      assert.isAbove(chat.lastActivity, chatOf(state, CHAT_B).lastActivity);
    });

    it('stores the same event id once, updating it in place', () => {
      let state = apply(loadedChatA(), 'event.message', wireEvent('$1'));
      state = apply(
        state,
        'event.message',
        wireEvent('$1', { content: { msgtype: 'm.text', body: 'edited' } })
      );
      assert.deepEqual(eventIds(state, CHAT_A), ['$1']);
      assert.deepEqual(firstEvent(state, CHAT_A).content, {
        msgtype: 'm.text',
        body: 'edited',
      });
      assert.strictEqual(chatOf(state, CHAT_A).unreadCount, 1);
    });

    it('follows pending → sent → failed', () => {
      const own = { sender: ME, streamOrder: 5 };
      let state = apply(
        loadedChatA(),
        'event.message',
        wireEvent('$t', { ...own, status: 'pending' })
      );
      assert.strictEqual(firstEvent(state, CHAT_A).status, 'pending');
      state = apply(
        state,
        'event.message',
        wireEvent('$t', { ...own, status: 'sent' })
      );
      assert.strictEqual(firstEvent(state, CHAT_A).status, 'sent');
      state = apply(
        state,
        'event.message',
        wireEvent('$t', { ...own, status: 'failed', errorCode: 'RATE_LIMITED' })
      );
      const event = firstEvent(state, CHAT_A);
      assert.strictEqual(event.status, 'failed');
      assert.strictEqual(event.errorCode, 'RATE_LIMITED');
      assert.deepEqual(eventIds(state, CHAT_A), ['$t']);
    });

    it('drops the body of a redacted event', () => {
      let state = apply(loadedChatA(), 'event.message', wireEvent('$1'));
      state = apply(
        state,
        'event.message',
        wireEvent('$1', {
          redacted: true,
          content: {
            msgtype: 'm.text',
            body: 'secret',
            'm.relates_to': { rel_type: 'x' },
          },
        })
      );
      const event = firstEvent(state, CHAT_A);
      assert.isTrue(event.redacted);
      assert.deepEqual(event.content, { 'm.relates_to': { rel_type: 'x' } });
      assert.notInclude(JSON.stringify(state), 'secret');
    });
  });

  it('event.chat upserts a chat and keeps its preview', () => {
    let state = apply(withChats(CHAT_A), 'event.message', wireEvent('$1'));
    state = apply(
      state,
      'event.chat',
      wireChat(CHAT_A, {
        name: 'Renamed',
        unreadCount: 7,
        avatar: 'mxc://truki.local/x',
      })
    );
    const chat = chatOf(state, CHAT_A);
    assert.strictEqual(chat.name, 'Renamed');
    assert.strictEqual(chat.unreadCount, 7);
    assert.strictEqual(chat.avatarMxc, 'mxc://truki.local/x');
    assert.isTrue(chat.isDM);
    assert.deepEqual(chat.preview, { text: 'body of $1', fromMe: false });
  });

  describe('event.accountState', () => {
    it('ignores an empty loginId', () => {
      const state = apply(getEmptyState(), 'event.accountState', {
        network: 'whatsapp',
        loginId: '',
        state: 'CONNECTED',
      });
      assert.lengthOf(state.accounts, 0);
    });

    it('replaces the account row including reason', () => {
      const failed = {
        network: 'whatsapp',
        loginId: 'l1',
        state: 'BAD_CREDENTIALS',
        reason: 'wa-logged-out',
      };
      let state = apply(getEmptyState(), 'event.accountState', failed);
      state = apply(state, 'event.accountState', {
        network: 'whatsapp',
        loginId: 'l1',
        state: 'CONNECTED',
      });
      assert.deepEqual(state.accounts, [
        {
          loginId: 'l1',
          network: 'whatsapp',
          remoteName: '',
          state: 'CONNECTED',
        },
      ]);

      state = apply(state, 'event.accountState', failed);
      assert.lengthOf(state.accounts, 1);
      assert.strictEqual(state.accounts[0]?.reason, 'wa-logged-out');
    });
  });

  describe('event.login.step', () => {
    it('ignores a step with a lower seq', () => {
      let state = reducer(
        getEmptyState(),
        loginStarted({
          processId: 'p1',
          network: 'whatsapp',
          step: { step_id: 'qr2' },
          seq: 2,
        })
      );
      state = apply(state, 'event.login.step', {
        processId: 'p1',
        step: { step_id: 'qr1' },
        seq: 1,
      });
      assert.deepEqual(loginOf(state, 'p1').step, { step_id: 'qr2' });
      state = apply(state, 'event.login.step', {
        processId: 'p1',
        step: { step_id: 'qr3' },
        seq: 3,
      });
      assert.deepEqual(loginOf(state, 'p1').step, { step_id: 'qr3' });
      assert.strictEqual(loginOf(state, 'p1').seq, 3);
    });

    it('buffers a step for an unknown process until loginStarted', () => {
      let state = apply(getEmptyState(), 'event.login.step', {
        processId: 'p1',
        step: { step_id: 'qr2' },
        seq: 2,
      });
      assert.isUndefined(state.loginProcesses.p1);
      assert.lengthOf(state.pendingLoginEvents.p1 ?? [], 1);

      state = reducer(
        state,
        loginStarted({
          processId: 'p1',
          network: 'whatsapp',
          step: { step_id: 'qr1' },
          seq: 1,
        })
      );
      assert.deepEqual(loginOf(state, 'p1').step, { step_id: 'qr2' });
      assert.strictEqual(loginOf(state, 'p1').seq, 2);
      assert.isUndefined(state.pendingLoginEvents.p1);
    });

    it('records an error pushed for a known process', () => {
      let state = reducer(
        getEmptyState(),
        loginStarted({ processId: 'p1', network: 'w', step: {}, seq: 1 })
      );
      state = apply(state, 'event.login.step', {
        processId: 'p1',
        error: { code: 'LOGIN_EXPIRED', message: 'expired' },
      });
      assert.deepEqual(loginOf(state, 'p1').error, {
        code: 'LOGIN_EXPIRED',
        message: 'expired',
      });
    });
  });

  describe('bridge restarts', () => {
    it('keeps chats, clears loading and replaces reloaded events', () => {
      let state = apply(withChats(CHAT_A, CHAT_B), 'event.supervisorState', {
        state: 'running',
      });
      state = reducer(
        { ...state, selectedChatId: CHAT_A },
        messagesLoaded(
          CHAT_A,
          [wireEvent('$2', { streamOrder: 2 }), wireEvent('$1')],
          'replace',
          true
        )
      );
      state = {
        ...state,
        messagesByChat: {
          [CHAT_A]: { ...messagesOf(state, CHAT_A), loading: true },
        },
      };

      state = apply(state, 'event.supervisorState', { state: 'stopped' });
      assert.strictEqual(state.bridgeState, 'stopped');
      assert.hasAllKeys(state.chats, [CHAT_A, CHAT_B]);
      assert.isFalse(messagesOf(state, CHAT_A).loading);

      state = apply(state, 'event.supervisorState', { state: 'running' });
      assert.strictEqual(state.bridgeState, 'running');
      assert.hasAllKeys(state.chats, [CHAT_A, CHAT_B]);

      state = reducer(
        state,
        messagesLoaded(
          CHAT_A,
          [
            wireEvent('$3', { streamOrder: 3 }),
            wireEvent('$2', { streamOrder: 2 }),
            wireEvent('$1'),
          ],
          'replace',
          false
        )
      );
      assert.deepEqual(eventIds(state, CHAT_A), ['$1', '$2', '$3']);
    });

    it('a replace load keeps events pushed while it was in flight', () => {
      let state = reducer(
        withChats(CHAT_A),
        messagesLoaded(
          CHAT_A,
          [
            wireEvent('$2', { streamOrder: 2 }),
            wireEvent('$t', { sender: ME, status: 'pending', streamOrder: 3 }),
          ],
          'replace',
          false
        )
      );
      state = reducer(state, messagesLoading(CHAT_A));
      state = apply(
        state,
        'event.message',
        wireEvent('$9', { streamOrder: 9, content: { body: 'new' } })
      );
      state = apply(
        state,
        'event.message',
        wireEvent('$t', { sender: ME, status: 'sent', streamOrder: 3 })
      );
      state = apply(
        state,
        'event.message',
        wireEvent('$2', {
          streamOrder: 2,
          redacted: true,
          content: { body: 'gone' },
        })
      );

      // The page was read before those pushes.
      state = reducer(
        state,
        messagesLoaded(
          CHAT_A,
          [
            wireEvent('$t', { sender: ME, status: 'pending', streamOrder: 3 }),
            wireEvent('$2', {
              streamOrder: 2,
              content: { body: 'secret body' },
            }),
            wireEvent('$1'),
          ],
          'replace',
          false
        )
      );
      const { events } = messagesOf(state, CHAT_A);
      assert.deepEqual(
        events.map(e => e.id),
        ['$1', '$2', '$t', '$9']
      );
      assert.strictEqual(events[1]?.redacted, true);
      assert.notInclude(JSON.stringify(state), 'secret body');
      assert.strictEqual(events[2]?.status, 'sent');
      assert.isFalse(messagesOf(state, CHAT_A).loading);
    });

    it('a replace load still drops stale events the page supersedes', () => {
      let state = reducer(
        withChats(CHAT_A),
        messagesLoaded(
          CHAT_A,
          [
            wireEvent('$old', {
              streamOrder: 2,
              status: 'pending',
              sender: ME,
            }),
          ],
          'replace',
          false
        )
      );
      state = reducer(state, messagesLoading(CHAT_A));
      state = reducer(
        state,
        messagesLoaded(
          CHAT_A,
          [
            wireEvent('$3', { streamOrder: 3 }),
            wireEvent('$old', { streamOrder: 2, status: 'failed', sender: ME }),
          ],
          'replace',
          false
        )
      );
      const { events } = messagesOf(state, CHAT_A);
      assert.deepEqual(
        events.map(e => [e.id, e.status]),
        [
          ['$old', 'failed'],
          ['$3', ''],
        ]
      );
    });

    it('older pages are prepended without duplicates', () => {
      let state = reducer(
        withChats(CHAT_A),
        messagesLoaded(
          CHAT_A,
          [
            wireEvent('$3', { streamOrder: 3 }),
            wireEvent('$2', { streamOrder: 2 }),
          ],
          'replace',
          true
        )
      );
      state = reducer(
        state,
        messagesLoaded(
          CHAT_A,
          [wireEvent('$2', { streamOrder: 2 }), wireEvent('$1')],
          'older',
          false
        )
      );
      assert.deepEqual(eventIds(state, CHAT_A), ['$1', '$2', '$3']);
      assert.isFalse(messagesOf(state, CHAT_A).hasOlder);
    });
  });

  describe('thunks', () => {
    type Call = { method: string; params: unknown };
    let calls: Array<Call>;
    let respond: (method: string, params: unknown) => unknown;
    let listener: ((e: TrukiBridgeEvent) => void) | undefined;

    // A minimal thunk-capable store holding only the trukiBridge slice.
    function makeStore() {
      let slice = getEmptyState();
      const getState = () => ({ trukiBridge: slice }) as unknown as StateType;
      const dispatch = (action: unknown): unknown => {
        if (typeof action === 'function') {
          return action(dispatch, getState, undefined);
        }
        slice = reducer(slice, action as TrukiBridgeAction);
        return action;
      };
      return { dispatch, state: () => slice };
    }

    async function flush(): Promise<void> {
      for (let i = 0; i < 5; i += 1) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          setImmediate(resolve);
        });
      }
    }

    function running(store: ReturnType<typeof makeStore>): void {
      store.dispatch(
        actions.trukiBridgeEventReceived(
          ev('event.supervisorState', { state: 'running' })
        )
      );
    }

    beforeEach(() => {
      calls = [];
      respond = () => ({});
      listener = undefined;
      const client: TrukiBridgeClient = {
        request: async <T>(method: string, params?: unknown) => {
          calls.push({ method, params });
          const value = respond(method, params);
          if (
            typeof value === 'object' &&
            value != null &&
            'ok' in value &&
            value.ok === false
          ) {
            return value as TrukiBridgeIpcResult<T>;
          }
          return { ok: true, value: value as T };
        },
        getState: async (): Promise<
          TrukiBridgeIpcResult<TrukiSupervisorStateName>
        > => ({ ok: true, value: 'running' }),
        onEvent: cb => {
          listener = cb;
          return () => {
            listener = undefined;
          };
        },
      };
      setTrukiBridgeClientForTesting(client);
    });

    afterEach(() => {
      setTrukiBridgeClientForTesting(undefined);
    });

    it('trukiBridgeStart subscribes once, pulls state and loads all pages', async () => {
      respond = (method, params) => {
        switch (method) {
          case 'networks.list':
            return [{ id: 'whatsapp', name: 'WhatsApp', enabled: true }];
          case 'accounts.list':
            return [
              {
                loginId: 'l1',
                network: 'whatsapp',
                remoteName: 'Me',
                state: 'CONNECTED',
              },
            ];
          case 'chats.list':
            return (params as { cursor?: string }).cursor === 'c2'
              ? { chats: [wireChat(CHAT_B)], nextCursor: '' }
              : { chats: [wireChat(CHAT_A)], nextCursor: 'c2' };
          default:
            return {};
        }
      };
      const store = makeStore();
      store.dispatch(actions.trukiBridgeStart());
      store.dispatch(actions.trukiBridgeStart());
      await flush();

      const state = store.state();
      assert.strictEqual(state.bridgeState, 'running');
      assert.lengthOf(state.networks, 1);
      assert.lengthOf(state.accounts, 1);
      assert.hasAllKeys(state.chats, [CHAT_A, CHAT_B]);
      assert.deepEqual(
        calls.filter(c => c.method === 'chats.list').map(c => c.params),
        [{ limit: 200 }, { cursor: 'c2', limit: 200 }]
      );
      assert.lengthOf(
        calls.filter(c => c.method === 'networks.list'),
        1
      );

      // Pushed events reach the store through the one subscription.
      listener?.(ev('event.chat', wireChat('!c:truki.local')));
      assert.isDefined(store.state().chats['!c:truki.local']);
    });

    it('an unknown chat in event.message triggers one chats.get', async () => {
      respond = method =>
        method === 'chats.get'
          ? { chat: wireChat(CHAT_A, { name: 'Filled' }), members: {} }
          : {};
      const store = makeStore();
      store.dispatch(
        actions.trukiBridgeEventReceived(
          ev('event.message', wireEvent('$1', { chatId: CHAT_A }))
        )
      );
      store.dispatch(
        actions.trukiBridgeEventReceived(
          ev('event.message', wireEvent('$2', { chatId: CHAT_A }))
        )
      );
      await flush();
      assert.lengthOf(
        calls.filter(c => c.method === 'chats.get'),
        1
      );
      assert.strictEqual(chatOf(store.state(), CHAT_A).name, 'Filled');
    });

    it('selectBridgedChat sets the id and loads messages; clear clears', async () => {
      respond = method =>
        method === 'messages.list' ? { events: [wireEvent('$1')] } : {};
      const store = makeStore();
      running(store);
      store.dispatch(actions.selectBridgedChat(CHAT_A));
      assert.strictEqual(store.state().selectedChatId, CHAT_A);
      await flush();
      assert.deepEqual(eventIds(store.state(), CHAT_A), ['$1']);
      store.dispatch(actions.clearBridgedSelection());
      assert.isUndefined(store.state().selectedChatId);
    });

    it('running after stopped reloads the open chat once', async () => {
      respond = method =>
        method === 'messages.list' ? { events: [wireEvent('$1')] } : {};
      const store = makeStore();
      running(store);
      store.dispatch(actions.selectBridgedChat(CHAT_A));
      await flush();
      store.dispatch(
        actions.trukiBridgeEventReceived(
          ev('event.supervisorState', { state: 'stopped' })
        )
      );
      calls = [];
      running(store);
      await flush();
      assert.lengthOf(
        calls.filter(c => c.method === 'messages.list'),
        1
      );
      assert.deepEqual(eventIds(store.state(), CHAT_A), ['$1']);
    });

    it('a failed request sets lastError and does not throw', async () => {
      respond = () => ({
        ok: false,
        code: 'BRIDGE_STOPPED',
        message: 'bridge is stopped',
      });
      const store = makeStore();
      store.dispatch(actions.sendText(CHAT_A, 'hi'));
      await flush();
      const { lastError } = store.state();
      assert.strictEqual(lastError?.code, 'BRIDGE_STOPPED');
      assert.strictEqual(lastError?.message, 'bridge is stopped');
      assert.deepEqual(calls, [
        { method: 'messages.send', params: { chatId: CHAT_A, text: 'hi' } },
      ]);
    });

    it('retrySend resends the failed event’s text and reply', async () => {
      const store = makeStore();
      store.dispatch(
        messagesLoaded(
          CHAT_A,
          [
            wireEvent('$t', {
              sender: ME,
              status: 'failed',
              content: {
                msgtype: 'm.text',
                body: 'again',
                'm.relates_to': { 'm.in_reply_to': { event_id: '$r' } },
              },
            }),
          ],
          'replace',
          false
        )
      );
      store.dispatch(actions.retrySend(CHAT_A, '$t'));
      await flush();
      assert.deepEqual(calls, [
        {
          method: 'messages.send',
          params: { chatId: CHAT_A, text: 'again', replyTo: '$r' },
        },
      ]);
    });

    function loadFailed(store: ReturnType<typeof makeStore>) {
      store.dispatch(
        messagesLoaded(
          CHAT_A,
          [
            wireEvent('$t', {
              sender: ME,
              status: 'failed',
              content: { msgtype: 'm.text', body: 'once' },
            }),
          ],
          'replace',
          false
        )
      );
    }

    it('retrySend sends a failed event at most once', async () => {
      const store = makeStore();
      loadFailed(store);
      store.dispatch(actions.retrySend(CHAT_A, '$t'));
      store.dispatch(actions.retrySend(CHAT_A, '$t'));
      await flush();
      store.dispatch(actions.retrySend(CHAT_A, '$t'));
      await flush();
      assert.lengthOf(
        calls.filter(c => c.method === 'messages.send'),
        1
      );
      assert.deepEqual(store.state().retriedByChat?.[CHAT_A], ['$t']);
    });

    it('a retry the bridge refused can be retried again', async () => {
      respond = () => ({
        ok: false,
        code: 'BRIDGE_STOPPED',
        message: 'bridge is stopped',
      });
      const store = makeStore();
      loadFailed(store);
      store.dispatch(actions.retrySend(CHAT_A, '$t'));
      await flush();
      assert.deepEqual(store.state().retriedByChat?.[CHAT_A], []);
      respond = () => ({});
      store.dispatch(actions.retrySend(CHAT_A, '$t'));
      await flush();
      assert.lengthOf(
        calls.filter(c => c.method === 'messages.send'),
        2
      );
      assert.deepEqual(store.state().retriedByChat?.[CHAT_A], ['$t']);
    });
  });
});
