// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { _getLeftPaneLists } from '../../../state/selectors/conversations.dom.ts';
import type { ConversationLookupType } from '../../../state/ducks/conversations.preload.ts';
import type { ConversationType } from '../../../state/ducks/conversations.preload.ts';
import {
  ChatFolderType,
  CHAT_FOLDER_DEFAULTS,
  type ChatFolder,
  type ChatFolderId,
} from '../../../types/ChatFolder.std.ts';

const conversation = {
  id: 'conversation-1',
  activeAt: 1,
  isArchived: false,
  isPinned: false,
} as ConversationType;

const allChatFolder = {
  ...CHAT_FOLDER_DEFAULTS,
  id: 'folder-all' as ChatFolderId,
  folderType: ChatFolderType.ALL,
  position: 0,
  deletedAtTimestampMs: 0,
  storageID: null,
  storageVersion: null,
  storageUnknownFields: null,
  storageNeedsSync: false,
} as ChatFolder;

describe('Truki hideFromAllChats stable selection', () => {
  it('keeps an open hidden conversation in General', () => {
    const lists = _getLeftPaneLists({
      conversationLookup: {
        [conversation.id]: conversation,
      } as ConversationLookupType,
      conversationComparator: () => 0,
      selectedConversationId: conversation.id,
      pinnedConversationIds: null,
      selectedChatFolder: allChatFolder,
      stableSelectedConversationIdInChatFolder: conversation.id,
      hiddenFromAllChatsConversationIds: new Set([conversation.id]),
    });

    assert.deepEqual(
      lists.conversations.map(item => item.id),
      [conversation.id]
    );
  });
});
