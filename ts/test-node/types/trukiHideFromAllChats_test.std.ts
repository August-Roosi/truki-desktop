// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  ChatFolderType,
  CHAT_FOLDER_DEFAULTS,
  isConversationInChatFolder,
  type ChatFolder,
  type ChatFolderId,
} from '../../types/ChatFolder.std.ts';
import type { CurrentChatFolder } from '../../types/CurrentChatFolders.std.ts';
import { CurrentChatFolders } from '../../types/CurrentChatFolders.std.ts';
import { getHiddenFromAllChatsConversationIds } from '../../state/selectors/chatFolders.std.ts';
import type { StateType } from '../../state/reducer.preload.ts';

function folder(overrides: Partial<ChatFolder>): ChatFolder {
  return {
    ...CHAT_FOLDER_DEFAULTS,
    id: 'folder-1' as ChatFolderId,
    position: 0,
    deletedAtTimestampMs: 0,
    storageID: null,
    storageVersion: null,
    storageUnknownFields: null,
    storageNeedsSync: false,
    ...overrides,
  };
}

const conversation = {
  id: 'convo-1',
  type: 'direct' as const,
  unreadCount: 0,
  markedUnread: false,
  muteExpiresAt: undefined,
};

describe('hideFromAllChats filtering', () => {
  const allFolder = folder({ folderType: ChatFolderType.ALL, name: '' });

  it('keeps upstream behaviour when no hidden set is passed', () => {
    assert.isTrue(isConversationInChatFolder(allFolder, conversation));
  });

  it('keeps upstream behaviour for an empty hidden set', () => {
    assert.isTrue(
      isConversationInChatFolder(allFolder, conversation, {
        hiddenFromAllChatsConversationIds: new Set(),
      })
    );
  });

  it('excludes a hidden conversation from the All-chats folder', () => {
    assert.isFalse(
      isConversationInChatFolder(allFolder, conversation, {
        hiddenFromAllChatsConversationIds: new Set(['convo-1']),
      })
    );
  });

  it('does not affect custom folders', () => {
    const custom = folder({
      folderType: ChatFolderType.CUSTOM,
      name: 'Work',
      includeAllIndividualChats: true,
    });
    assert.isTrue(
      isConversationInChatFolder(custom, conversation, {
        hiddenFromAllChatsConversationIds: new Set(['convo-1']),
      })
    );
  });
});

function currentFolder(overrides: Partial<ChatFolder>): CurrentChatFolder {
  return folder(overrides) as CurrentChatFolder;
}

function getHiddenConversationIds(
  currentChatFolders: CurrentChatFolders
): ReadonlySet<string> {
  return getHiddenFromAllChatsConversationIds({
    chatFolders: { currentChatFolders },
  } as StateType);
}

describe('getHiddenFromAllChatsConversationIds', () => {
  it('is empty when no space hides', () => {
    const currentChatFolders = CurrentChatFolders.fromArray([
      currentFolder({
        id: 'folder-a' as ChatFolderId,
        folderType: ChatFolderType.CUSTOM,
        hideFromAllChats: false,
      }),
      currentFolder({
        id: 'folder-b' as ChatFolderId,
        folderType: ChatFolderType.CUSTOM,
        hideFromAllChats: false,
      }),
    ]);

    assert.deepEqual([...getHiddenConversationIds(currentChatFolders)], []);
  });

  it('unions members across several hiding spaces', () => {
    const currentChatFolders = CurrentChatFolders.fromArray([
      currentFolder({
        id: 'folder-a' as ChatFolderId,
        folderType: ChatFolderType.CUSTOM,
        hideFromAllChats: true,
        includedConversationIds: ['a', 'b'],
      }),
      currentFolder({
        id: 'folder-b' as ChatFolderId,
        folderType: ChatFolderType.CUSTOM,
        hideFromAllChats: true,
        includedConversationIds: ['b', 'c'],
      }),
    ]);

    assert.sameMembers(
      [...getHiddenConversationIds(currentChatFolders)],
      ['a', 'b', 'c']
    );
  });

  it('ignores a deleted space', () => {
    const deletedChatFolder = folder({
      id: 'folder-deleted' as ChatFolderId,
      folderType: ChatFolderType.CUSTOM,
      hideFromAllChats: true,
      includedConversationIds: ['a'],
      deletedAtTimestampMs: 1,
    });
    // getCurrentChatFolders normally contains live folders only. Construct an
    // intentionally malformed fixture to regression-test the selector's
    // defensive deleted-folder guard.
    const currentChatFolders = {
      order: [deletedChatFolder.id],
      lookup: { [deletedChatFolder.id]: deletedChatFolder },
      currentAllChatFolder: null,
      hasAnyCurrentCustomChatFolders: true,
    } as CurrentChatFolders;

    assert.deepEqual([...getHiddenConversationIds(currentChatFolders)], []);
  });

  it('ignores the All-chats folder itself', () => {
    const currentChatFolders = CurrentChatFolders.fromArray([
      currentFolder({
        id: 'folder-all' as ChatFolderId,
        folderType: ChatFolderType.ALL,
        hideFromAllChats: true,
        includedConversationIds: ['a'],
      }),
    ]);

    assert.deepEqual([...getHiddenConversationIds(currentChatFolders)], []);
  });
});
