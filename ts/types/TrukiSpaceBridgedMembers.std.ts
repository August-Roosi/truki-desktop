// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { TrukiBridgedChatSummary } from '../state/ducks/trukiBridge.preload.ts';

/**
 * Which bridged chats belong to each Space (upstream: chat folder). The
 * keys are ChatFolderIds. Stored locally in Signal's item storage under
 * 'trukiSpaceBridgedMembers'; not synced by the storage service.
 */
export type TrukiSpaceBridgedMembers = Readonly<
  Record<
    string /* ChatFolderId */,
    {
      chatIds: ReadonlyArray<string>;
      networks: ReadonlyArray<string>;
    }
  >
>;

/**
 * Is this bridged chat a member of this Space? A chat is a member when its
 * id is listed in `chatIds` or its network is listed in `networks`.
 */
export function trukiChatInSpace(
  chat: TrukiBridgedChatSummary,
  members: TrukiSpaceBridgedMembers[string] | undefined
): boolean {
  if (members == null) {
    return false;
  }
  return (
    members.chatIds.includes(chat.id) || members.networks.includes(chat.network)
  );
}
