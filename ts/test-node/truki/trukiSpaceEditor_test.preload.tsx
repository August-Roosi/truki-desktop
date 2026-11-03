// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import * as sinon from 'sinon';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import type { LanguageTag } from '@signalapp/types';

import { AxoProvider } from '../../axo/AxoProvider.dom.tsx';
import type { AxoIntl } from '../../axo/_internal/AxoIntl.dom.tsx';
import { TrukiSpaceOtherNetworks } from '../../components/preferences/chatFolders/TrukiSpaceOtherNetworks.dom.tsx';
import { getTrukiSpaceBadgeValue } from '../../components/leftPane/TrukiSpaceBar.dom.tsx';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import {
  addTrukiChatToSpace,
  getTrukiSpaceMembers,
  saveTrukiMembersForNewSpace,
  setTrukiSpaceMembers,
} from '../../services/trukiSpaceMembers.preload.ts';
import { getTrukiUnreadCountByFolder } from '../../state/selectors/trukiBridge.std.ts';
import type {
  TrukiBridgedChatSummary,
  TrukiBridgeStateType,
} from '../../state/ducks/trukiBridge.preload.ts';
import type { StateType } from '../../state/reducer.preload.ts';
import { CurrentChatFolders } from '../../types/CurrentChatFolders.std.ts';
import type { CurrentChatFolder } from '../../types/CurrentChatFolders.std.ts';
import {
  ChatFolderType,
  CHAT_FOLDER_DEFAULTS,
  type ChatFolderId,
} from '../../types/ChatFolder.std.ts';
import type { TrukiSpaceBridgedMembers } from '../../types/TrukiSpaceBridgedMembers.std.ts';
import {
  EMPTY_TRUKI_SPACE_MEMBERS,
  getTrukiConnectedNetworks,
  isSameTrukiSpaceMembers,
  setTrukiSpaceChat,
  setTrukiSpaceNetwork,
} from '../../util/trukiSpaceMembersEdit.std.ts';
import { setupI18n } from '../../util/setupI18n.dom.tsx';
import type { UnreadStats } from '../../util/countUnreadStats.std.ts';
import enMessages from '../../../_locales/en/messages.json' with { type: 'json' };

const i18n = setupI18n('en', enMessages);

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

function withAxo(node: JSX.Element): string {
  return renderToStaticMarkup(
    <AxoProvider
      resolvedAppLocale={{
        tag: 'en' as AxoIntl.AppLocaleTag,
        direction: 'ltr',
      }}
      systemPreferredLanguages={new Set(['en' as LanguageTag])}
      messages={AXO_MESSAGES}
    >
      {node}
    </AxoProvider>
  );
}

function chat(
  id: string,
  overrides: Partial<TrukiBridgedChatSummary> = {}
): TrukiBridgedChatSummary {
  return {
    id,
    network: 'whatsapp',
    loginId: 'l1',
    name: id,
    isDM: true,
    unreadCount: 0,
    lastActivity: 1,
    ...overrides,
  };
}

function folder(
  id: string,
  overrides: {
    folderType?: ChatFolderType.ALL | ChatFolderType.CUSTOM;
    hideFromAllChats?: boolean;
  } = {}
): CurrentChatFolder {
  return {
    ...CHAT_FOLDER_DEFAULTS,
    name: id,
    id: id as ChatFolderId,
    folderType: ChatFolderType.CUSTOM,
    position: 0,
    deletedAtTimestampMs: 0,
    storageID: null,
    storageVersion: null,
    storageUnknownFields: null,
    storageNeedsSync: false,
    ...overrides,
  };
}

function rootState(
  chats: Record<string, TrukiBridgedChatSummary>,
  members: TrukiSpaceBridgedMembers,
  folders: ReadonlyArray<CurrentChatFolder>
): StateType {
  const trukiBridge: TrukiBridgeStateType = {
    bridgeState: 'running',
    networks: [],
    accounts: [],
    chats,
    selectedChatId: undefined,
    messagesByChat: {},
    loginProcesses: {},
    pendingLoginEvents: {},
    typingByChat: {},
    lastError: undefined,
  };
  return {
    trukiBridge,
    items: { trukiSpaceBridgedMembers: members },
    chatFolders: {
      currentChatFolders: CurrentChatFolders.fromArray(folders),
      selectedChatFolderId: null,
      stableSelectedConversationIdInChatFolder: null,
    },
  } as unknown as StateType;
}

function stats(unreadCount: number, unreadChatsCount: number): UnreadStats {
  return {
    unreadCount,
    unreadChatsCount,
    readChatsMarkedUnreadCount: 0,
  } as UnreadStats;
}

describe('trukiSpaceEditor', () => {
  describe('membership edits', () => {
    it('toggling a network adds and removes it', () => {
      const on = setTrukiSpaceNetwork(EMPTY_TRUKI_SPACE_MEMBERS, 'meta', true);
      assert.deepEqual(on, { chatIds: [], networks: ['meta'] });
      assert.deepEqual(setTrukiSpaceNetwork(on, 'meta', false), {
        chatIds: [],
        networks: [],
      });
    });

    it('picking a chat keeps the networks and does not duplicate', () => {
      const entry = { chatIds: ['a'], networks: ['meta'] };
      const next = setTrukiSpaceChat(
        setTrukiSpaceChat(entry, 'b', true),
        'b',
        true
      );
      assert.deepEqual(next, { chatIds: ['a', 'b'], networks: ['meta'] });
    });

    it('compares entries as sets', () => {
      assert.isTrue(
        isSameTrukiSpaceMembers(
          { chatIds: ['a', 'b'], networks: [] },
          { chatIds: ['b', 'a'], networks: [] }
        )
      );
      assert.isFalse(
        isSameTrukiSpaceMembers(
          { chatIds: ['a'], networks: [] },
          { chatIds: ['a'], networks: ['meta'] }
        )
      );
    });

    it('offers only networks that have an account', () => {
      const result = getTrukiConnectedNetworks(
        [{ network: 'whatsapp' }, { network: 'whatsapp' }],
        [
          { id: 'whatsapp', name: 'WhatsApp' },
          { id: 'meta', name: 'Messenger' },
        ]
      );
      assert.deepEqual(result, [{ id: 'whatsapp', name: 'WhatsApp' }]);
    });
  });

  describe('TrukiSpaceOtherNetworks', () => {
    const chats = [
      chat('wa-1', { name: 'Mari WA' }),
      chat('m-1', { network: 'meta', name: 'Jaan Messenger' }),
    ];

    it('lists only the networks it is given and their chats', () => {
      const markup = withAxo(
        <TrukiSpaceOtherNetworks
          i18n={i18n}
          networks={[{ id: 'whatsapp', name: 'WhatsApp' }]}
          chats={chats}
          value={EMPTY_TRUKI_SPACE_MEMBERS}
          onChange={() => undefined}
        />
      );
      assert.include(markup, 'All WhatsApp chats');
      assert.notInclude(markup, 'Messenger');
      assert.include(markup, 'Mari WA');
      assert.notInclude(markup, 'Jaan Messenger');
    });

    it('renders nothing without a connected network', () => {
      const markup = withAxo(
        <TrukiSpaceOtherNetworks
          i18n={i18n}
          networks={[]}
          chats={chats}
          value={EMPTY_TRUKI_SPACE_MEMBERS}
          onChange={() => undefined}
        />
      );
      assert.notInclude(markup, 'Other networks');
    });

    it('hides chats of a network that is selected as a whole', () => {
      const markup = withAxo(
        <TrukiSpaceOtherNetworks
          i18n={i18n}
          networks={[{ id: 'whatsapp', name: 'WhatsApp' }]}
          chats={chats}
          value={{ chatIds: [], networks: ['whatsapp'] }}
          onChange={() => undefined}
        />
      );
      assert.notInclude(markup, 'Mari WA');
    });
  });

  describe('storage', () => {
    const sandbox = sinon.createSandbox();
    let backing: Record<string, unknown>;

    beforeEach(() => {
      backing = {};
      sandbox.stub(itemStorage, 'get').callsFake(key => backing[key]);
      // A slow put: the value lands after a tick, like a real write.
      sandbox.stub(itemStorage, 'put').callsFake(async (key, value) => {
        await new Promise(resolve => {
          setTimeout(resolve, 5);
        });
        backing[key] = value;
      });
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('two concurrent writes for different Spaces both persist', async () => {
      await Promise.all([
        setTrukiSpaceMembers('f1', { chatIds: ['c1'], networks: [] }),
        setTrukiSpaceMembers('f2', { chatIds: [], networks: ['meta'] }),
      ]);
      assert.deepEqual(getTrukiSpaceMembers(), {
        f1: { chatIds: ['c1'], networks: [] },
        f2: { chatIds: [], networks: ['meta'] },
      });
    });

    it('addTrukiChatToSpace adds the chat id once and keeps the rest', async () => {
      await setTrukiSpaceMembers('f1', { chatIds: ['a'], networks: ['meta'] });
      await Promise.all([
        addTrukiChatToSpace('f1', 'b'),
        addTrukiChatToSpace('f1', 'b'),
        addTrukiChatToSpace('f2', 'c'),
      ]);
      assert.deepEqual(getTrukiSpaceMembers(), {
        f1: { chatIds: ['a', 'b'], networks: ['meta'] },
        f2: { chatIds: ['c'], networks: [] },
      });
    });

    describe('saveTrukiMembersForNewSpace', () => {
      it('writes members only after the new folder is in the folder list', async () => {
        let folderIds: ReadonlyArray<string> = ['all'];
        const listeners = new Set<() => void>();
        const events: Array<string> = [];

        const result = saveTrukiMembersForNewSpace({
          knownFolderIds: new Set(folderIds),
          // Resolves before the folder shows up in redux.
          create: async () => {
            events.push('created');
          },
          getFolderIds: () => folderIds,
          subscribe: cb => {
            listeners.add(cb);
            return () => listeners.delete(cb);
          },
          members: { chatIds: ['c1'], networks: ['meta'] },
        });

        await new Promise(resolve => {
          setTimeout(resolve, 20);
        });
        assert.deepEqual(events, ['created']);
        assert.deepEqual(getTrukiSpaceMembers(), {});

        folderIds = ['all', 'new-id'];
        listeners.forEach(cb => cb());
        assert.strictEqual(await result, 'new-id');
        assert.deepEqual(getTrukiSpaceMembers(), {
          'new-id': { chatIds: ['c1'], networks: ['meta'] },
        });
      });

      it('writes nothing when no folder appears', async () => {
        const result = await saveTrukiMembersForNewSpace({
          knownFolderIds: new Set(['all']),
          create: async () => undefined,
          getFolderIds: () => ['all'],
          subscribe: () => () => undefined,
          members: { chatIds: ['c1'], networks: [] },
          timeoutMs: 20,
        });
        assert.isUndefined(result);
        assert.deepEqual(getTrukiSpaceMembers(), {});
      });
    });
  });

  describe('bridged unread on the Space bar', () => {
    const chats = {
      'wa-1': chat('wa-1', { unreadCount: 2 }),
      'wa-2': chat('wa-2', { unreadCount: 1 }),
      'm-1': chat('m-1', { network: 'meta', unreadCount: 3 }),
    };
    const members: TrukiSpaceBridgedMembers = {
      f1: { chatIds: ['wa-1'], networks: ['meta'] },
    };
    const all = folder('all', { folderType: ChatFolderType.ALL });
    const f1 = folder('f1', { hideFromAllChats: true });

    it('computes every Space in one map, for General and custom Spaces', () => {
      const state = rootState(chats, members, [all, f1]);
      const map = getTrukiUnreadCountByFolder(state);
      assert.strictEqual(map.get('f1'), 5);
      // wa-1 and m-1 are claimed by f1, which hides them from General.
      assert.strictEqual(map.get('all'), 1);
      assert.strictEqual(getTrukiUnreadCountByFolder(state), map);
    });

    it('badge value is Signal unread plus bridged unread', () => {
      const state = rootState(chats, members, [all, f1]);
      const map = getTrukiUnreadCountByFolder(state);
      assert.strictEqual(
        getTrukiSpaceBadgeValue(stats(4, 2), 'unread-messages', map.get('f1')),
        9
      );
      assert.strictEqual(
        getTrukiSpaceBadgeValue(stats(4, 2), 'unread-messages', map.get('all')),
        5
      );
    });

    it('shows the bridged count alone when Signal has none, and null for zero', () => {
      assert.strictEqual(
        getTrukiSpaceBadgeValue(null, 'unread-messages', 3),
        3
      );
      assert.isNull(
        getTrukiSpaceBadgeValue(null, 'unread-messages', undefined)
      );
      assert.isNull(getTrukiSpaceBadgeValue(stats(0, 0), 'unread-messages', 0));
    });
  });
});
