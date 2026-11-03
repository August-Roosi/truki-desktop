// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LanguageTag } from '@signalapp/types';

import { AxoProvider } from '../../axo/AxoProvider.dom.tsx';
import type { AxoIntl } from '../../axo/_internal/AxoIntl.dom.tsx';

import { TrukiBridgedConversation } from '../../components/truki/TrukiBridgedConversation.dom.tsx';
import type { TrukiBridgedConversationProps } from '../../components/truki/TrukiBridgedConversation.dom.tsx';
import { shouldAutoLoadOlder } from '../../components/truki/TrukiBridgedTimeline.dom.tsx';
import {
  actions,
  getEmptyState,
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
import type { LocalizerType } from '../../types/Util.std.ts';
import { trukiSaveReceivedFile } from '../../state/smart/TrukiBridgedConversation.preload.tsx';
import type {
  TrukiBridgeEvent,
  TrukiBridgeIpcResult,
  TrukiSupervisorStateName,
} from '../../../app/truki/trukiBridgeProtocol.std.ts';

const i18n = ((key: string) => key) as unknown as LocalizerType;

const AXO_MESSAGES: AxoIntl.Messages = {
  'AxoAlertDialog.Cancel': 'Cancel',
  'AxoButton.Pending': 'Pending',
  'AxoDialog.Back': 'Back',
  'AxoDialog.Close': 'Close',
  'AxoTextField.Clear': 'Clear',
  'AxoPasswordField.Reveal': 'Show Password',
  'AxoBadge.MaxOverflow': (max: number) => `${max}+`,
  'AxoContactName.InSystemContactsLabel': 'In contacts',
};

const CHAT_A = '!a:truki.local';
const ME = '@me:truki.local';
const THEM = '@whatsapp_1:truki.local';

const CHAT: TrukiBridgedChatSummary = {
  id: CHAT_A,
  network: 'whatsapp',
  loginId: 'login1',
  name: 'Mari',
  isDM: true,
  unreadCount: 0,
  lastActivity: 0,
};

function noop() {
  return undefined;
}

function render(
  overrides: Partial<TrukiBridgedConversationProps> = {}
): string {
  const props: TrukiBridgedConversationProps = {
    i18n,
    chatId: CHAT_A,
    chat: CHAT,
    events: [],
    hasOlder: false,
    loading: false,
    localUserId: ME,
    networkName: 'WhatsApp',
    accountName: 'Me',
    bridgeState: 'running',
    accountState: 'CONNECTED',
    typingUsers: [],
    onLoadOlder: noop,
    onMarkRead: noop,
    onSend: noop,
    onReact: noop,
    onRedact: noop,
    onRetry: noop,
    onSetMuted: noop,
    onAttach: async () => false,
    onDismissError: noop,
    ...overrides,
  };
  return renderToStaticMarkup(
    <AxoProvider
      resolvedAppLocale={{
        tag: 'en' as AxoIntl.AppLocaleTag,
        direction: 'ltr',
      }}
      systemPreferredLanguages={new Set(['en' as LanguageTag])}
      messages={AXO_MESSAGES}
    >
      <TrukiBridgedConversation {...props} />
    </AxoProvider>
  );
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

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

describe('trukiBridgedConversation view', () => {
  it('renders "chat unavailable" when the chat is gone, without throwing', () => {
    let markup = '';
    assert.doesNotThrow(() => {
      markup = render({ chat: undefined });
    });
    assert.include(markup, 'icu:TrukiBridgedConversation__Unavailable');
    assert.notInclude(markup, 'data-testid="TrukiBridgedComposer"');
  });

  it('a chat removed from the store renders unavailable', () => {
    let state = reducer(
      getEmptyState(),
      trukiBridgeEventApplied(
        {
          method: 'event.chat',
          params: { id: CHAT_A, network: 'whatsapp', name: 'Mari' },
        },
        0
      )
    );
    assert.isDefined(state.chats[CHAT_A]);
    // A chats.list reload that no longer has the chat drops it.
    state = reducer(state, { type: 'trukiBridge/CHATS_LOADED', payload: [] });
    const markup = render({ chat: state.chats[CHAT_A] });
    assert.include(markup, 'icu:TrukiBridgedConversation__Unavailable');
  });

  it('a LOGGED_OUT account shows the Reconnect banner', () => {
    const withButton = render({
      accountState: 'LOGGED_OUT',
      onReconnectAccount: noop,
    });
    assert.include(withButton, 'icu:TrukiBridgedConversation__LoggedOut');
    assert.include(withButton, 'icu:TrukiBridgedConversation__Reconnect');

    // Until Task 10 wires Reconnect, the banner is text only.
    const textOnly = render({ accountState: 'LOGGED_OUT' });
    assert.include(textOnly, 'icu:TrukiBridgedConversation__LoggedOut');
    assert.notInclude(textOnly, 'icu:TrukiBridgedConversation__Reconnect');
  });

  it('a stopped bridge shows the bridge banner and disables the composer', () => {
    const markup = render({ bridgeState: 'stopped', onRestartBridge: noop });
    assert.include(markup, 'icu:TrukiBridgedConversation__BridgeDown');
    assert.include(markup, 'icu:TrukiBridgedConversation__Restart');
    assert.match(markup, /<textarea[^>]* disabled=""/);
    assert.notMatch(render(), /<textarea[^>]* disabled=""/);
  });

  it('a RATE_LIMITED error shows the network-specific text', () => {
    const markup = render({
      error: { code: 'RATE_LIMITED', message: 'slow down' },
    });
    assert.include(markup, 'icu:TrukiBridgedConversation__RateLimited');

    const failed = render({
      events: [
        {
          id: '$truki-1',
          chatId: CHAT_A,
          sender: ME,
          type: 'm.room.message',
          content: { msgtype: 'm.text', body: 'hi' },
          timestamp: 1,
          streamOrder: 1,
          status: 'failed',
          errorCode: 'RATE_LIMITED',
          redacted: false,
        },
      ],
    });
    assert.include(failed, 'icu:TrukiBridgedConversation__RateLimited');
    assert.include(failed, 'icu:TrukiBridgedConversation__Retry');
  });

  describe('bridge restart', () => {
    afterEach(() => {
      setTrukiBridgeClientForTesting(undefined);
    });

    it('stopped → running reloads messages once, without duplicates', async () => {
      let listCalls = 0;
      const client: TrukiBridgeClient = {
        request: async <T,>(method: string) => {
          if (method === 'messages.list') {
            listCalls += 1;
            return {
              ok: true,
              value: {
                events: [
                  wireEvent('$2', { streamOrder: 2 }),
                  wireEvent('$1', { streamOrder: 1 }),
                ],
              } as T,
            };
          }
          return { ok: true, value: {} as T };
        },
        getState: async (): Promise<
          TrukiBridgeIpcResult<TrukiSupervisorStateName>
        > => ({ ok: true, value: 'running' }),
        restart: async (): Promise<TrukiBridgeIpcResult<void>> => ({
          ok: true,
          value: undefined,
        }),
        onEvent: () => () => undefined,
      };
      setTrukiBridgeClientForTesting(client);

      let slice: TrukiBridgeStateType = getEmptyState();
      const getState = () => ({ trukiBridge: slice }) as unknown as StateType;
      const dispatch = (action: unknown): unknown => {
        if (typeof action === 'function') {
          return action(dispatch, getState, undefined);
        }
        slice = reducer(slice, action as TrukiBridgeAction);
        return action;
      };
      const flush = async () => {
        for (let i = 0; i < 5; i += 1) {
          // oxlint-disable-next-line no-await-in-loop
          await new Promise(resolve => {
            setImmediate(resolve);
          });
        }
      };
      const supervisor = (state: string): TrukiBridgeEvent => ({
        method: 'event.supervisorState',
        params: { state },
      });

      dispatch(actions.trukiBridgeEventReceived(supervisor('running')));
      dispatch(actions.selectBridgedChat(CHAT_A));
      await flush();
      dispatch(actions.trukiBridgeEventReceived(supervisor('stopped')));
      listCalls = 0;
      dispatch(actions.trukiBridgeEventReceived(supervisor('running')));
      await flush();

      assert.strictEqual(listCalls, 1);
      const entry = slice.messagesByChat[CHAT_A];
      const markup = render({
        events: entry?.events ?? [],
        bridgeState: slice.bridgeState,
      });
      assert.strictEqual(count(markup, 'data-testid="TrukiBridgedBubble"'), 2);
      assert.strictEqual(count(markup, 'body of $1'), 1);
      assert.strictEqual(count(markup, 'body of $2'), 1);
    });
  });

  it('a retried failed event shows "Sent again" instead of Retry', () => {
    const failedEvent = {
      id: '$truki-1',
      chatId: CHAT_A,
      sender: ME,
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'hi' },
      timestamp: 1,
      streamOrder: 1,
      status: 'failed' as const,
      redacted: false,
    };
    const before = render({ events: [failedEvent] });
    assert.include(before, 'icu:TrukiBridgedConversation__Retry');
    const after = render({
      events: [failedEvent],
      retriedEventIds: ['$truki-1'],
    });
    assert.notInclude(after, 'icu:TrukiBridgedConversation__Retry');
    assert.include(after, 'icu:TrukiBridgedConversation__SentAgain');
  });

  it('a received bridge file has a Save button; others do not', () => {
    const file = (id: string, url?: string) => ({
      id,
      chatId: CHAT_A,
      sender: THEM,
      type: 'm.room.message',
      content: {
        msgtype: 'm.file',
        body: `${id}.pdf`,
        ...(url ? { url } : {}),
      },
      timestamp: 1,
      streamOrder: 1,
      status: '' as const,
      redacted: false,
    });
    const withSave = render({
      events: [file('$1', `mxc://truki.local/${'d'.repeat(64)}`)],
      onSaveMedia: noop,
    });
    assert.include(withSave, 'icu:TrukiBridgedConversation__SaveFile');
    assert.notInclude(
      render({
        events: [file('$2', 'mxc://elsewhere.org/x')],
        onSaveMedia: noop,
      }),
      'icu:TrukiBridgedConversation__SaveFile'
    );
  });

  it('saving a file asks main with the event mxc and shows a failure', async () => {
    const mxc = `mxc://truki.local/${'d'.repeat(64)}`;
    const saved: Array<unknown> = [];
    const errors: Array<unknown> = [];
    await trukiSaveReceivedFile(mxc, 'a.pdf', {
      save: async params => {
        saved.push(params);
        return { ok: true, value: { saved: true } };
      },
      onError: e => errors.push(e),
    });
    await trukiSaveReceivedFile(mxc, 'a.pdf', {
      save: async () => ({ ok: false, code: 'NOT_FOUND', message: 'gone' }),
      onError: e => errors.push(e),
    });
    assert.deepEqual(saved, [{ mxc, suggestedName: 'a.pdf' }]);
    assert.deepEqual(errors, [{ code: 'NOT_FOUND', message: 'gone' }]);
  });

  it('renders redacted, edited, reply, reactions and media', () => {
    const base = {
      chatId: CHAT_A,
      sender: THEM,
      type: 'm.room.message',
      timestamp: 1,
      status: '' as const,
      redacted: false,
    };
    const markup = render({
      events: [
        { ...base, id: '$del', streamOrder: 1, redacted: true, content: {} },
        {
          ...base,
          id: '$1',
          streamOrder: 2,
          content: { msgtype: 'm.text', body: 'original' },
        },
        {
          ...base,
          id: '$e',
          streamOrder: 3,
          relatesTo: '$1',
          relType: 'm.replace',
          content: {
            msgtype: 'm.text',
            body: '* changed',
            'm.new_content': { msgtype: 'm.text', body: 'changed' },
          },
        },
        {
          ...base,
          id: '$r',
          streamOrder: 4,
          type: 'm.reaction',
          relatesTo: '$1',
          relType: 'm.annotation',
          content: {
            'm.relates_to': {
              rel_type: 'm.annotation',
              event_id: '$1',
              key: '👍',
            },
          },
        },
        {
          ...base,
          id: '$img',
          streamOrder: 5,
          content: {
            msgtype: 'm.image',
            body: 'p.jpg',
            url: `mxc://truki.local/${'b'.repeat(64)}`,
            'm.relates_to': { 'm.in_reply_to': { event_id: '$1' } },
          },
        },
      ],
    });
    assert.include(markup, 'icu:TrukiBridgedConversation__Deleted');
    assert.include(markup, 'icu:MessageMetadata__edited');
    assert.notInclude(markup, 'original');
    assert.strictEqual(count(markup, 'changed'), 2); // bubble + quote
    assert.include(markup, '👍');
    assert.include(markup, `truki-media://truki.local/${'b'.repeat(64)}`);
  });
});

describe('TrukiBridgedTimeline shouldAutoLoadOlder', () => {
  const base = {
    hasOlder: true,
    loading: false,
    scrollHeight: 300,
    clientHeight: 600,
  };

  it('loads when older pages exist and the content does not fill the view', () => {
    assert.isTrue(shouldAutoLoadOlder(base));
    assert.isTrue(
      shouldAutoLoadOlder({ ...base, scrollHeight: 600, clientHeight: 600 })
    );
  });

  it('does not load once the content scrolls', () => {
    assert.isFalse(shouldAutoLoadOlder({ ...base, scrollHeight: 601 }));
  });

  it('does not load while loading or without older pages', () => {
    assert.isFalse(shouldAutoLoadOlder({ ...base, loading: true }));
    assert.isFalse(shouldAutoLoadOlder({ ...base, hasOlder: false }));
  });
});
