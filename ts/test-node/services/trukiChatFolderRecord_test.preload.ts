// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { SignalService as Proto } from '../../protobuf/index.std.ts';
import {
  toChatFolderRecord,
  trukiChatFolderFieldsFromRecord,
} from '../../services/storageRecordOps.preload.ts';
import type { ChatFolder, ChatFolderId } from '../../types/ChatFolder.std.ts';
import { ChatFolderType } from '../../types/ChatFolder.std.ts';

const CHAT_FOLDER_ID = '00000000-0000-4000-8000-000000000001' as ChatFolderId;

function createChatFolder(partial: Partial<ChatFolder> = {}): ChatFolder {
  return {
    id: CHAT_FOLDER_ID,
    folderType: ChatFolderType.CUSTOM,
    name: 'Work',
    emoji: null,
    color: null,
    position: 0,
    showOnlyUnread: false,
    showMutedChats: false,
    includeAllIndividualChats: false,
    includeAllGroupChats: false,
    includedConversationIds: [],
    excludedConversationIds: [],
    hideFromAllChats: false,
    deletedAtTimestampMs: 0,
    storageID: null,
    storageVersion: null,
    storageUnknownFields: null,
    storageNeedsSync: false,
    ...partial,
  };
}

function encodeAndDecode(
  record: Proto.ChatFolderRecord.Params
): Proto.ChatFolderRecord {
  return Proto.ChatFolderRecord.decode(Proto.ChatFolderRecord.encode(record));
}

describe('trukiChatFolderRecord', () => {
  it('round-trips emoji, color and hideFromAllChats', () => {
    const record = toChatFolderRecord(
      createChatFolder({
        emoji: '💼',
        color: 0xff3a7d44,
        hideFromAllChats: true,
      })
    );

    const decoded = encodeAndDecode(record);
    const trukiFields = trukiChatFolderFieldsFromRecord(decoded);

    assert.strictEqual(trukiFields.emoji, '💼');
    assert.strictEqual(trukiFields.color, 0xff3a7d44);
    assert.strictEqual(trukiFields.hideFromAllChats, true);
  });

  it('maps a wire color of 0 back to null, not black', () => {
    const decoded = encodeAndDecode({
      ...toChatFolderRecord(createChatFolder()),
      color: 0,
    });

    assert.strictEqual(trukiChatFolderFieldsFromRecord(decoded).color, null);
  });

  it('treats an absent emoji as null', () => {
    const decoded = encodeAndDecode({
      ...toChatFolderRecord(createChatFolder()),
      emoji: null,
    });

    assert.strictEqual(trukiChatFolderFieldsFromRecord(decoded).emoji, null);
  });

  it('still preserves $unknown alongside the Truki fields', () => {
    const unknown = new Uint8Array([0x98, 0x06, 0x01]);
    const decoded = encodeAndDecode(
      toChatFolderRecord(
        createChatFolder({
          emoji: '💼',
          color: 0xff3a7d44,
          hideFromAllChats: true,
          storageUnknownFields: unknown,
        })
      )
    );

    assert.deepEqual(decoded.$unknown, [unknown]);
    assert.deepInclude(trukiChatFolderFieldsFromRecord(decoded), {
      emoji: '💼',
      color: 0xff3a7d44,
      hideFromAllChats: true,
    });
  });
});
