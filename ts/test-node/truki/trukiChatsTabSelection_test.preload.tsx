// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatsTab } from '../../components/ChatsTab.dom.tsx';
import type {
  ChatsTabProps,
  TrukiChatsTabProps,
} from '../../components/ChatsTab.dom.tsx';
import {
  actions,
  getEmptyState,
  reducer,
} from '../../state/ducks/trukiBridge.preload.ts';
import type { TrukiBridgeAction } from '../../state/ducks/trukiBridge.preload.ts';
import type { StateType } from '../../state/reducer.preload.ts';
import { setupI18n } from '../../util/setupI18n.dom.tsx';
import enMessages from '../../../_locales/en/messages.json' with { type: 'json' };
import {
  trukiOnSignalConversationChanged,
  trukiSelectBridgedChat,
} from '../../util/trukiBridgedSelection.std.ts';

const i18n = setupI18n('en', enMessages);
const WELCOME = i18n('icu:welcomeToSignal');

const CHAT_A = '!a:truki.local';
const SIGNAL_A = 'signal-conversation-a';

// The selection as the app holds it: the trukiBridge slice in a minimal
// thunk-capable store, and Signal's selected conversation id beside it.
function makeApp() {
  let slice = getEmptyState();
  let signalSelected: string | undefined;
  const getState = () => ({ trukiBridge: slice }) as unknown as StateType;
  const dispatch = (action: unknown): unknown => {
    if (typeof action === 'function') {
      return action(dispatch, getState, undefined);
    }
    slice = reducer(slice, action as TrukiBridgeAction);
    return action;
  };
  // What SmartChatsTab's effect does when Signal's selection changes.
  function signalChanged(id: string | undefined) {
    signalSelected = id;
    trukiOnSignalConversationChanged(id, () =>
      dispatch(actions.clearBridgedSelection())
    );
  }
  return {
    selectBridged(chatId: string) {
      trukiSelectBridgedChat(chatId, {
        showConversation: options => {
          signalChanged(options.conversationId);
        },
        selectBridgedChat: id => dispatch(actions.selectBridgedChat(id)),
      });
    },
    selectSignal(id: string) {
      signalChanged(id);
    },
    render(withTruki = true): string {
      const props: ChatsTabProps & TrukiChatsTabProps = {
        otherTabsUnreadCount: 0,
        i18n,
        isStaging: false,
        hasPendingUpdate: false,
        hasFailedStorySends: false,
        navTabsCollapsed: false,
        onToggleNavTabsCollapse: () => undefined,
        renderConversationView: ({ selectedConversationId }) => (
          <div data-view="signal">{selectedConversationId}</div>
        ),
        renderLeftPane: () => <div />,
        renderMiniPlayer: () => <div />,
        selectedConversationId: signalSelected,
        showWhatsNewModal: () => undefined,
        ...(withTruki
          ? {
              trukiSelectedChatId: slice.selectedChatId,
              renderTrukiConversation: (chatId: string) => (
                <div data-view="truki">{chatId}</div>
              ),
            }
          : {}),
      };
      return renderToStaticMarkup(<ChatsTab {...props} />);
    },
    state: () => ({ truki: slice.selectedChatId, signal: signalSelected }),
  };
}

function views(markup: string): Array<string> {
  return [...markup.matchAll(/data-view="(\w+)"/g)].map(m => m[1] ?? '');
}

describe('ChatsTab truki panel switch', () => {
  it('without truki props renders the splash as before', () => {
    const app = makeApp();
    const markup = app.render(false);
    assert.include(markup, WELCOME);
    assert.deepEqual(views(markup), []);
  });

  it('renders the bridged conversation when a bridged chat is selected', () => {
    const app = makeApp();
    app.selectBridged(CHAT_A);
    const markup = app.render();
    assert.deepEqual(views(markup), ['truki']);
    assert.include(markup, CHAT_A);
    assert.notInclude(markup, WELCOME);
  });

  it('selecting a Signal conversation clears the bridged selection', () => {
    const app = makeApp();
    app.selectBridged(CHAT_A);
    app.selectSignal(SIGNAL_A);
    assert.deepEqual(app.state(), { truki: undefined, signal: SIGNAL_A });
    assert.deepEqual(views(app.render()), ['signal']);
  });

  it('alternating 20 times never shows both', () => {
    const app = makeApp();
    for (let i = 0; i < 20; i += 1) {
      app.selectBridged(CHAT_A);
      assert.deepEqual(app.state(), { truki: CHAT_A, signal: undefined });
      assert.deepEqual(views(app.render()), ['truki']);

      app.selectSignal(`${SIGNAL_A}-${i}`);
      assert.deepEqual(app.state(), {
        truki: undefined,
        signal: `${SIGNAL_A}-${i}`,
      });
      assert.deepEqual(views(app.render()), ['signal']);
    }
  });

  it('prefers the Signal view if both are momentarily set', () => {
    const app = makeApp();
    app.selectBridged(CHAT_A);
    const props = {
      otherTabsUnreadCount: 0,
      i18n,
      isStaging: false,
      hasPendingUpdate: false,
      hasFailedStorySends: false,
      navTabsCollapsed: false,
      onToggleNavTabsCollapse: () => undefined,
      renderConversationView: () => <div data-view="signal" />,
      renderLeftPane: () => <div />,
      renderMiniPlayer: () => <div />,
      selectedConversationId: SIGNAL_A,
      showWhatsNewModal: () => undefined,
      trukiSelectedChatId: CHAT_A,
      renderTrukiConversation: () => <div data-view="truki" />,
    };
    assert.deepEqual(views(renderToStaticMarkup(<ChatsTab {...props} />)), [
      'signal',
    ]);
  });
});
