// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { SignalService as Proto } from '../protobuf/index.std.ts';
import type { ChatFolder } from './ChatFolder.std.ts';
import { ChatFolderType } from './ChatFolder.std.ts';

// Truki lets the user rename General, which is upstream's ALL chat folder.
// Signal requires that folder's name to be empty: libsignal's backup validator
// rejects any backup whose ALL folder has a name (`AllFolderInvalidName`). A
// synced name therefore breaks the phone's backups and the message-history
// transfer to newly linked devices. So General's custom name never goes in
// Signal's `name` field; Truki carries it in `generalName` (storage field
// 20004), which official clients round-trip as an unknown field.

type NamedChatFolder = Pick<ChatFolder, 'folderType' | 'name'>;

/** The name to put in Signal's own `name` field: always empty for General. */
export function getSignalChatFolderName(chatFolder: NamedChatFolder): string {
  return chatFolder.folderType === ChatFolderType.ALL ? '' : chatFolder.name;
}

/** General's custom name for the Truki `generalName` field, if it has one. */
export function getTrukiGeneralName(
  chatFolder: NamedChatFolder
): string | null {
  if (chatFolder.folderType !== ChatFolderType.ALL || chatFolder.name === '') {
    return null;
  }
  return chatFolder.name;
}

/**
 * Reads a folder's name back from a storage record. A record written by Truki
 * before `generalName` existed has General's name in `name`; that is kept, so
 * the rename survives until the record is rewritten in the new shape.
 */
export function getChatFolderNameFromRecord(
  record: Pick<Proto.ChatFolderRecord, 'folderType' | 'name' | 'generalName'>
): string {
  if (record.folderType === Proto.ChatFolderRecord.FolderType.ALL) {
    return record.generalName || record.name || '';
  }
  return record.name ?? '';
}
