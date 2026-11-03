// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import * as sinon from 'sinon';

import { itemStorage } from '../../textsecure/Storage.preload.ts';
import {
  getTrukiSpaceMembers,
  removeTrukiSpace,
  setTrukiSpaceMembers,
  trukiChatInSpace,
} from '../../services/trukiSpaceMembers.preload.ts';
import {
  getTrukiChatListForFolder,
  getTrukiUnreadCountForFolder,
} from '../../state/selectors/trukiBridge.std.ts';
import type {
  TrukiBridgedChatSummary,
  TrukiBridgeStateType,
} from '../../state/ducks/trukiBridge.preload.ts';
import type { StateType } from '../../state/reducer.preload.ts';
import type { CurrentChatFolder } from '../../types/CurrentChatFolders.std.ts';
import { CurrentChatFolders } from '../../types/CurrentChatFolders.std.ts';
import {
  ChatFolderType,
  CHAT_FOLDER_DEFAULTS,
  type ChatFolderId,
} from '../../types/ChatFolder.std.ts';
import type { TrukiSpaceBridgedMembers } from '../../types/TrukiSpaceBridgedMembers.std.ts';

function chat(
  id: string,
  overrides: {
    network?: string;
    unreadCount?: number;
    lastActivity?: number;
  } = {}
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

function rootState(options: {
  chats: Record<string, TrukiBridgedChatSummary>;
  members?: TrukiSpaceBridgedMembers;
  folders?: ReadonlyArray<CurrentChatFolder>;
}): StateType {
  const trukiBridge: TrukiBridgeStateType = {
    bridgeState: 'running',
    networks: [],
    accounts: [],
    chats: options.chats,
    selectedChatId: undefined,
    messagesByChat: {},
    loginProcesses: {},
    pendingLoginEvents: {},
    typingByChat: {},
    lastError: undefined,
  };
  return {
    trukiBridge,
    items: { trukiSpaceBridgedMembers: options.members },
    chatFolders: {
      currentChatFolders: CurrentChatFolders.fromArray(options.folders ?? []),
      selectedChatFolderId: null,
      stableSelectedConversationIdInChatFolder: null,
    },
  } as unknown as StateType;
}

describe('trukiSpaceMembers', () => {
  describe('trukiChatInSpace', () => {
    it('matches by chat id, by network, or both', () => {
      const members: TrukiSpaceBridgedMembers = {
        f1: { chatIds: ['c1'], networks: ['meta'] },
      };
      const m = members.f1;

      // by chat id
      assert.isTrue(trukiChatInSpace(chat('c1'), m));
      assert.isFalse(trukiChatInSpace(chat('c2'), m));

      // by network
      assert.isTrue(trukiChatInSpace(chat('m1', { network: 'meta' }), m));
      assert.isFalse(trukiChatInSpace(chat('wa1', { network: 'whatsapp' }), m));

      // both rules coexist on one entry
      const both: TrukiSpaceBridgedMembers = {
        f2: { chatIds: ['c1'], networks: ['whatsapp'] },
      };
      assert.isTrue(trukiChatInSpace(chat('c1'), both.f2));
      assert.isTrue(
        trukiChatInSpace(chat('wa2', { network: 'whatsapp' }), both.f2)
      );
      assert.isFalse(
        trukiChatInSpace(chat('ig1', { network: 'instagram' }), both.f2)
      );
    });

    it('returns false without a members entry', () => {
      assert.isFalse(trukiChatInSpace(chat('c1'), undefined));
    });
  });

  describe('storage', () => {
    const sandbox = sinon.createSandbox();
    let backing: Record<string, unknown>;
    let putCalls: ReadonlyArray<[string, unknown]>;

    beforeEach(() => {
      backing = {};
      putCalls = [];
      sandbox.stub(itemStorage, 'get').callsFake(key => backing[key]);
      sandbox.stub(itemStorage, 'put').callsFake(async (key, value) => {
        backing[key] = value;
        putCalls = [...putCalls, [key, value]];
      });
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('getTrukiSpaceMembers reads empty when nothing is stored', () => {
      assert.deepEqual(getTrukiSpaceMembers(), {});
    });

    it('setTrukiSpaceMembers writes one entry and merges with existing', async () => {
      await setTrukiSpaceMembers('f1', { chatIds: ['c1'], networks: [] });
      await setTrukiSpaceMembers('f2', { chatIds: [], networks: ['meta'] });

      assert.deepEqual(getTrukiSpaceMembers(), {
        f1: { chatIds: ['c1'], networks: [] },
        f2: { chatIds: [], networks: ['meta'] },
      });
    });

    it('setTrukiSpaceMembers replaces an entry without touching others', async () => {
      await setTrukiSpaceMembers('f1', { chatIds: ['c1'], networks: [] });
      await setTrukiSpaceMembers('f1', { chatIds: ['c2'], networks: [] });

      assert.deepEqual(getTrukiSpaceMembers(), {
        f1: { chatIds: ['c2'], networks: [] },
      });
      assert.lengthOf(putCalls, 2);
    });

    it('removeTrukiSpace deletes one entry and keeps the rest', async () => {
      await setTrukiSpaceMembers('f1', { chatIds: ['c1'], networks: [] });
      await setTrukiSpaceMembers('f2', { chatIds: [], networks: ['meta'] });
      await removeTrukiSpace('f1');

      assert.deepEqual(getTrukiSpaceMembers(), {
        f2: { chatIds: [], networks: ['meta'] },
      });
    });

    it('removeTrukiSpace does not write when the folder has no entry', async () => {
      await removeTrukiSpace('missing');

      assert.isEmpty(putCalls);
      assert.deepEqual(getTrukiSpaceMembers(), {});
    });
  });

  describe('getTrukiChatListForFolder', () => {
    const members: TrukiSpaceBridgedMembers = {
      f1: { chatIds: ['wa-1'], networks: ['meta'] },
      f2: { chatIds: [], networks: [] },
      vanished: { chatIds: ['wa-3'], networks: [] },
    };
    const chats: Record<string, TrukiBridgedChatSummary> = {
      'wa-1': chat('wa-1', { unreadCount: 2 }),
      'wa-2': chat('wa-2', { unreadCount: 1 }),
      'wa-3': chat('wa-3', { unreadCount: 4 }),
      'm-1': chat('m-1', { network: 'meta', unreadCount: 3 }),
      'ig-1': chat('ig-1', { network: 'instagram', unreadCount: 1 }),
    };

    it('a CUSTOM space shows chats in chatIds or with a matching network', () => {
      const state = rootState({
        chats,
        members,
        folders: [folder('f1'), folder('f2')],
      });

      assert.deepEqual(
        getTrukiChatListForFolder(state, folder('f1')).map(c => c.id),
        ['m-1', 'wa-1']
      );
    });

    it('a CUSTOM space without an entry shows no bridged chats', () => {
      const state = rootState({
        chats,
        members,
        folders: [folder('f1'), folder('f2')],
      });

      assert.deepEqual(
        getTrukiChatListForFolder(state, folder('f2')).map(c => c.id),
        []
      );
    });

    it('the General space hides chats claimed by hide-from-General spaces', () => {
      const state = rootState({
        chats,
        members,
        folders: [
          folder('all', { folderType: ChatFolderType.ALL }),
          folder('f1', { hideFromAllChats: true }),
          folder('f2'),
        ],
      });

      // f1 claims wa-1 (by chat id) and m-1 (by network) and hides them.
      assert.deepEqual(
        getTrukiChatListForFolder(
          state,
          folder('all', { folderType: ChatFolderType.ALL })
        ).map(c => c.id),
        ['ig-1', 'wa-2', 'wa-3']
      );
    });

    it('the General space keeps chats from spaces that do not hide them', () => {
      const state = rootState({
        chats,
        members,
        folders: [
          folder('all', { folderType: ChatFolderType.ALL }),
          folder('f1'),
        ],
      });

      assert.deepEqual(
        getTrukiChatListForFolder(
          state,
          folder('all', { folderType: ChatFolderType.ALL })
        ).map(c => c.id),
        ['ig-1', 'm-1', 'wa-1', 'wa-2', 'wa-3']
      );
    });

    it('entries for folders that no longer exist are ignored', () => {
      // 'vanished' claims wa-3 but is not in the folder list, so wa-3
      // belongs to General.
      const state = rootState({
        chats,
        members,
        folders: [
          folder('all', { folderType: ChatFolderType.ALL }),
          folder('f1', { hideFromAllChats: true }),
        ],
      });

      const list = getTrukiChatListForFolder(
        state,
        folder('all', { folderType: ChatFolderType.ALL })
      );

      assert.include(
        list.map(c => c.id),
        'wa-3'
      );
      assert.deepEqual(
        list.map(c => c.id),
        ['ig-1', 'wa-2', 'wa-3']
      );
    });

    it('a null folder behaves like the General space', () => {
      const state = rootState({
        chats,
        members,
        folders: [
          folder('all', { folderType: ChatFolderType.ALL }),
          folder('f1', { hideFromAllChats: true }),
        ],
      });

      assert.deepEqual(
        getTrukiChatListForFolder(state, null).map(c => c.id),
        ['ig-1', 'wa-2', 'wa-3']
      );
    });

    it('is memoized per folder', () => {
      const state = rootState({
        chats,
        members,
        folders: [folder('f1'), folder('f2')],
      });

      const f1 = folder('f1');
      const f2 = folder('f2');

      const first = getTrukiChatListForFolder(state, f1);
      assert.strictEqual(getTrukiChatListForFolder(state, f1), first);
      assert.notStrictEqual(getTrukiChatListForFolder(state, f2), first);
      // switching back recomputes but yields the same content
      assert.deepEqual(getTrukiChatListForFolder(state, f1), first);
    });
  });

  describe('getTrukiUnreadCountForFolder', () => {
    const members: TrukiSpaceBridgedMembers = {
      f1: { chatIds: ['wa-1'], networks: ['meta'] },
      vanished: { chatIds: ['wa-3'], networks: [] },
    };
    const chats: Record<string, TrukiBridgedChatSummary> = {
      'wa-1': chat('wa-1', { unreadCount: 2 }),
      'wa-2': chat('wa-2', { unreadCount: 1 }),
      'wa-3': chat('wa-3', { unreadCount: 4 }),
      'm-1': chat('m-1', { network: 'meta', unreadCount: 3 }),
    };

    it('sums bridged unread in the space', () => {
      const state = rootState({
        chats,
        members,
        folders: [folder('f1')],
      });

      assert.strictEqual(getTrukiUnreadCountForFolder(state, folder('f1')), 5);
    });

    it('the General space excludes chats hidden by hide-from-General spaces', () => {
      const state = rootState({
        chats,
        members,
        folders: [
          folder('all', { folderType: ChatFolderType.ALL }),
          folder('f1', { hideFromAllChats: true }),
        ],
      });

      // wa-2 (1) + wa-3 (4); wa-1 and m-1 are hidden in f1.
      assert.strictEqual(
        getTrukiUnreadCountForFolder(
          state,
          folder('all', { folderType: ChatFolderType.ALL })
        ),
        5
      );
    });

    it('ignores entries for folders that no longer exist', () => {
      // 'vanished' claims wa-3 (unread 4) but is gone, so its unread
      // belongs to General.
      const state = rootState({
        chats,
        members,
        folders: [folder('all', { folderType: ChatFolderType.ALL })],
      });

      assert.strictEqual(
        getTrukiUnreadCountForFolder(
          state,
          folder('all', { folderType: ChatFolderType.ALL })
        ),
        10
      );
    });
  });
});
