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
import { getHidingChatFolders } from '../../state/selectors/chatFolders.std.ts';
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

const groupConversation = {
  ...conversation,
  id: 'group-1',
  type: 'group' as const,
};

const allFolder = folder({ folderType: ChatFolderType.ALL, name: '' });

describe('hideFromAllChats filtering', () => {
  it('keeps upstream behaviour when no hiding spaces are passed', () => {
    assert.isTrue(isConversationInChatFolder(allFolder, conversation));
  });

  it('keeps upstream behaviour for no hiding spaces', () => {
    assert.isTrue(
      isConversationInChatFolder(allFolder, conversation, {
        hidingChatFolders: [],
      })
    );
  });

  it('excludes a hidden conversation from the All-chats folder', () => {
    const hidingFolder = folder({
      folderType: ChatFolderType.CUSTOM,
      hideFromAllChats: true,
      includedConversationIds: [conversation.id],
    });
    assert.isFalse(
      isConversationInChatFolder(allFolder, conversation, {
        hidingChatFolders: [hidingFolder],
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
        hidingChatFolders: [
          folder({
            folderType: ChatFolderType.CUSTOM,
            hideFromAllChats: true,
            includedConversationIds: [conversation.id],
          }),
        ],
      })
    );
  });

  it('hides group chats, but not direct chats, for an all-groups space', () => {
    const hidingFolder = folder({
      folderType: ChatFolderType.CUSTOM,
      hideFromAllChats: true,
      includeAllGroupChats: true,
    });

    assert.isFalse(
      isConversationInChatFolder(allFolder, groupConversation, {
        hidingChatFolders: [hidingFolder],
      })
    );
    assert.isTrue(
      isConversationInChatFolder(allFolder, conversation, {
        hidingChatFolders: [hidingFolder],
      })
    );
  });

  it('hides direct chats, but not group chats, for an all-individuals space', () => {
    const hidingFolder = folder({
      folderType: ChatFolderType.CUSTOM,
      hideFromAllChats: true,
      includeAllIndividualChats: true,
    });

    assert.isFalse(
      isConversationInChatFolder(allFolder, conversation, {
        hidingChatFolders: [hidingFolder],
      })
    );
    assert.isTrue(
      isConversationInChatFolder(allFolder, groupConversation, {
        hidingChatFolders: [hidingFolder],
      })
    );
  });

  it('does not hide a conversation excluded from a hiding space', () => {
    const hidingFolder = folder({
      folderType: ChatFolderType.CUSTOM,
      hideFromAllChats: true,
      includeAllIndividualChats: true,
      excludedConversationIds: [conversation.id],
    });

    assert.isTrue(
      isConversationInChatFolder(allFolder, conversation, {
        hidingChatFolders: [hidingFolder],
      })
    );
  });

  it('hides a read conversation from an unread-only hiding space', () => {
    const hidingFolder = folder({
      folderType: ChatFolderType.CUSTOM,
      hideFromAllChats: true,
      includeAllIndividualChats: true,
      showOnlyUnread: true,
    });

    assert.isFalse(
      isConversationInChatFolder(allFolder, conversation, {
        hidingChatFolders: [hidingFolder],
      })
    );
  });
});

function currentFolder(overrides: Partial<ChatFolder>): CurrentChatFolder {
  return folder(overrides) as CurrentChatFolder;
}

function getHidingFolders(
  currentChatFolders: CurrentChatFolders
): ReadonlyArray<ChatFolder> {
  return getHidingChatFolders({
    chatFolders: { currentChatFolders },
  } as StateType);
}

describe('getHidingChatFolders', () => {
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

    const hidingChatFolders = getHidingFolders(currentChatFolders);
    assert.deepEqual(hidingChatFolders, []);
    assert.isTrue(
      isConversationInChatFolder(allFolder, conversation, {
        hidingChatFolders,
      })
    );
  });

  it('returns every live custom hiding space', () => {
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
      getHidingFolders(currentChatFolders).map(chatFolder => chatFolder.id),
      ['folder-a', 'folder-b']
    );
  });

  it('ignores a deleted space', () => {
    const deletedChatFolder = folder({
      id: 'folder-deleted' as ChatFolderId,
      folderType: ChatFolderType.CUSTOM,
      hideFromAllChats: true,
      includedConversationIds: [conversation.id],
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

    const hidingChatFolders = getHidingFolders(currentChatFolders);
    assert.deepEqual(hidingChatFolders, []);
    assert.isTrue(
      isConversationInChatFolder(allFolder, conversation, {
        hidingChatFolders,
      })
    );
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

    assert.deepEqual(getHidingFolders(currentChatFolders), []);
  });
});
