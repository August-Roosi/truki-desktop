// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../logging/log.std.ts';
import { runStorageServiceUploadJobAfterEnabled } from '../services/storage.preload.ts';
import { DataReader, DataWriter } from '../sql/Client.preload.ts';
import { ChatFolderType } from '../types/ChatFolder.std.ts';
import { getTrukiGeneralName } from '../types/TrukiGeneralName.std.ts';

const log = createLogger('trukiResyncGeneralName');

/**
 * Before `generalName` existed, Truki synced General's custom name in
 * Signal's ALL-folder `name`, which makes the phone's backups fail
 * validation. Re-uploading General replaces that storage record with the
 * corrected shape (empty `name`, the custom name in `generalName`), and the
 * phone picks the empty name up on its next sync.
 *
 * Called from the version-upgrade block, so it runs once per new version and
 * only does anything when General has a custom name.
 */
export async function trukiResyncGeneralName(): Promise<void> {
  const chatFolders = await DataReader.getCurrentChatFolders();
  const general = chatFolders.find(
    chatFolder => chatFolder.folderType === ChatFolderType.ALL
  );
  if (general == null || getTrukiGeneralName(general) == null) {
    return;
  }

  log.info('re-uploading General so its custom name leaves the ALL name');
  await DataWriter.updateChatFolder({ ...general, storageNeedsSync: true });
  runStorageServiceUploadJobAfterEnabled({ reason: 'trukiResyncGeneralName' });
}
