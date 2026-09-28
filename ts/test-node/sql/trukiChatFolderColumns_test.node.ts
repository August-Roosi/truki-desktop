// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { cwd } from 'node:process';

import { v4 as generateUuid } from 'uuid';

import type { WritableDB } from '../../sql/Interface.std.ts';
import { setupTests } from '../../sql/Server.node.ts';
import {
  createAllChatsChatFolder,
  createChatFolder,
  getChatFolder,
  updateChatFolder,
  upsertAllChatsChatFolderFromSync,
} from '../../sql/server/chatFolders.std.ts';
import {
  type ChatFolder,
  type ChatFolderId,
  CHAT_FOLDER_DEFAULTS,
} from '../../types/ChatFolder.std.ts';
import { createDB } from './helpers.node.ts';

function createFolder(overrides: Partial<ChatFolder> = {}): ChatFolder {
  return {
    ...CHAT_FOLDER_DEFAULTS,
    id: generateUuid() as ChatFolderId,
    name: 'Work',
    position: 1,
    deletedAtTimestampMs: 0,
    storageID: null,
    storageVersion: null,
    storageUnknownFields: null,
    storageNeedsSync: true,
    ...overrides,
  };
}

describe('trukiChatFolderColumns', () => {
  let db: WritableDB;

  beforeEach(() => {
    db = createDB();
    setupTests(db, { userDataPath: cwd() });
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips emoji, color and hideFromAllChats', () => {
    const folder = createFolder({
      emoji: '💼',
      color: 0xff3a7d44,
      hideFromAllChats: true,
    });

    createChatFolder(db, folder);
    const read = getChatFolder(db, folder.id);

    assert.strictEqual(read?.emoji, '💼');
    assert.strictEqual(read?.color, 0xff3a7d44);
    assert.strictEqual(read?.hideFromAllChats, true);
  });

  it('round-trips null emoji and color', () => {
    const folder = createFolder({
      emoji: null,
      color: null,
      hideFromAllChats: false,
    });

    createChatFolder(db, folder);
    const read = getChatFolder(db, folder.id);

    assert.strictEqual(read?.emoji, null);
    assert.strictEqual(read?.color, null);
    assert.strictEqual(read?.hideFromAllChats, false);
  });

  it('persists updates to the three fields', () => {
    const folder = createFolder();
    createChatFolder(db, folder);

    const updated = {
      ...folder,
      emoji: '📚',
      color: 0xff2c6bed,
      hideFromAllChats: true,
    };
    updateChatFolder(db, updated);
    const read = getChatFolder(db, folder.id);

    assert.strictEqual(read?.emoji, '📚');
    assert.strictEqual(read?.color, 0xff2c6bed);
    assert.strictEqual(read?.hideFromAllChats, true);
  });

  it('syncs name, emoji and color onto the All-chats folder', () => {
    const allChats = createAllChatsChatFolder(db);
    const synced = {
      ...allChats,
      id: generateUuid() as ChatFolderId,
      name: 'General',
      emoji: '🏠',
      color: 0xff2c6bed,
      showOnlyUnread: true,
      showMutedChats: false,
      includeAllIndividualChats: false,
      includeAllGroupChats: false,
      includedConversationIds: ['should-not-sync'],
      excludedConversationIds: ['should-not-sync'],
    };

    upsertAllChatsChatFolderFromSync(db, synced);
    const read = getChatFolder(db, synced.id);

    assert.strictEqual(read?.name, 'General');
    assert.strictEqual(read?.emoji, '🏠');
    assert.strictEqual(read?.color, 0xff2c6bed);
    assert.strictEqual(read?.showOnlyUnread, allChats.showOnlyUnread);
    assert.strictEqual(read?.showMutedChats, allChats.showMutedChats);
    assert.strictEqual(
      read?.includeAllIndividualChats,
      allChats.includeAllIndividualChats
    );
    assert.strictEqual(read?.includeAllGroupChats, allChats.includeAllGroupChats);
    assert.deepStrictEqual(
      read?.includedConversationIds,
      allChats.includedConversationIds
    );
    assert.deepStrictEqual(
      read?.excludedConversationIds,
      allChats.excludedConversationIds
    );
  });
});
