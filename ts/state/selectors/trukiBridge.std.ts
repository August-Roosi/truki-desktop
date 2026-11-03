// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { createSelector } from 'reselect';
import type { StateType } from '../reducer.preload.ts';
import type { StateSelector } from '../types.std.ts';
import type {
  TrukiBridgedChatSummary,
  TrukiBridgeStateType,
} from '../ducks/trukiBridge.preload.ts';
import type { ChatFolder } from '../../types/ChatFolder.std.ts';
import { ChatFolderType } from '../../types/ChatFolder.std.ts';
import {
  getCurrentChatFolders,
  getHidingChatFolders,
} from './chatFolders.std.ts';
import { CurrentChatFolders } from '../../types/CurrentChatFolders.std.ts';
import {
  trukiChatInSpace,
  type TrukiSpaceBridgedMembers,
} from '../../types/TrukiSpaceBridgedMembers.std.ts';

export const getTrukiBridge = (state: StateType): TrukiBridgeStateType =>
  state.trukiBridge;

export const getTrukiSelectedChatId: StateSelector<string | undefined> =
  createSelector(getTrukiBridge, state => state.selectedChatId);

// Newest activity first; equal times are ordered by id so the list is stable.
export const getTrukiChatList: StateSelector<
  ReadonlyArray<TrukiBridgedChatSummary>
> = createSelector(
  (state: StateType) => getTrukiBridge(state).chats,
  chats =>
    Object.values(chats).sort((a, b) => {
      if (a.lastActivity !== b.lastActivity) {
        return b.lastActivity - a.lastActivity;
      }
      if (a.id === b.id) {
        return 0;
      }
      return a.id < b.id ? -1 : 1;
    })
);

// Spaces membership as the renderer sees it. trukiSpaceMembers.preload.ts
// writes it through itemStorage, which feeds the items duck.
const getTrukiSpaceBridgedMembers = (
  state: StateType
): TrukiSpaceBridgedMembers => state.items.trukiSpaceBridgedMembers ?? {};

// The bridged chats visible in one Space. A CUSTOM Space shows its member
// chats; the General Space (folderType ALL, or no Space selected) shows
// every bridged chat except those claimed by a Space that hides its chats
// from General. Member entries for folder ids that no longer exist are
// never consulted.
function getChatsForFolder(
  folder: ChatFolder | null,
  chats: ReadonlyArray<TrukiBridgedChatSummary>,
  members: TrukiSpaceBridgedMembers,
  hidingChatFolders: ReadonlyArray<ChatFolder>
): ReadonlyArray<TrukiBridgedChatSummary> {
  if (folder != null && folder.folderType === ChatFolderType.CUSTOM) {
    const folderMembers = members[folder.id];
    return folderMembers == null
      ? []
      : chats.filter(chat => trukiChatInSpace(chat, folderMembers));
  }
  return chats.filter(chat =>
    hidingChatFolders.every(
      hidingFolder => !trukiChatInSpace(chat, members[hidingFolder.id])
    )
  );
}

export const getTrukiChatListForFolder: (
  s: StateType,
  folder: ChatFolder | null
) => ReadonlyArray<TrukiBridgedChatSummary> = createSelector(
  (_state: StateType, folder: ChatFolder | null) => folder,
  getTrukiChatList,
  getTrukiSpaceBridgedMembers,
  getHidingChatFolders,
  getChatsForFolder
);

// Bridged unread for one Space's badge. Plugs into the Space bar's unread
// stats; see the task report for where it is wired.
export const getTrukiUnreadCountForFolder: (
  s: StateType,
  folder: ChatFolder | null
) => number = createSelector(getTrukiChatListForFolder, chats =>
  chats.reduce((total, chat) => total + chat.unreadCount, 0)
);

// Bridged unread in both units the Space badge can show: messages, or the
// number of chats with something unread.
export type TrukiBridgedUnread = Readonly<{ messages: number; chats: number }>;

// Bridged unread for every Space in one pass, keyed by folder id (General
// included). The Space bar adds these to the unread stats Signal computes.
export const getTrukiUnreadCountByFolder: (
  s: StateType
) => ReadonlyMap<string, TrukiBridgedUnread> = createSelector(
  getTrukiChatList,
  getTrukiSpaceBridgedMembers,
  getHidingChatFolders,
  getCurrentChatFolders,
  (chats, members, hidingChatFolders, currentChatFolders) => {
    const result = new Map<string, TrukiBridgedUnread>();
    for (const folder of CurrentChatFolders.toSortedArray(currentChatFolders)) {
      const visible = getChatsForFolder(
        folder,
        chats,
        members,
        hidingChatFolders
      );
      result.set(folder.id, {
        messages: visible.reduce((total, chat) => total + chat.unreadCount, 0),
        chats: visible.filter(chat => chat.unreadCount > 0).length,
      });
    }
    return result;
  }
);
