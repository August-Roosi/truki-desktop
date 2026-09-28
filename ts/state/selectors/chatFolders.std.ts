// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createSelector } from 'reselect';
import type { StateType } from '../reducer.preload.ts';
import type { StateSelector } from '../types.std.ts';
import type { ChatFoldersState } from '../ducks/chatFolders.preload.ts';
import type { CurrentChatFolder } from '../../types/CurrentChatFolders.std.ts';
import { CurrentChatFolders } from '../../types/CurrentChatFolders.std.ts';
import {
  ChatFolderType,
  type ChatFolder,
} from '../../types/ChatFolder.std.ts';

function getChatFoldersState(state: StateType): ChatFoldersState {
  return state.chatFolders;
}

export const getCurrentChatFolders: StateSelector<CurrentChatFolders> =
  createSelector(getChatFoldersState, state => {
    return state.currentChatFolders;
  });

export const getCurrentChatFoldersCount: StateSelector<number> = createSelector(
  getCurrentChatFolders,
  currentChatFolders => {
    return CurrentChatFolders.size(currentChatFolders);
  }
);

export const getHasAnyCurrentCustomChatFolders: StateSelector<boolean> =
  createSelector(getCurrentChatFolders, currentChatFolders => {
    return currentChatFolders.hasAnyCurrentCustomChatFolders;
  });

/**
 * Truki: live CUSTOM spaces with hideFromAllChats set. The membership
 * predicate evaluates each space's inclusion rules when filtering General.
 */
export const getHidingChatFolders: StateSelector<ReadonlyArray<ChatFolder>> =
  createSelector(getCurrentChatFolders, currentChatFolders => {
    return CurrentChatFolders.toSortedArray(currentChatFolders).filter(
      chatFolder =>
        chatFolder.folderType === ChatFolderType.CUSTOM &&
        chatFolder.hideFromAllChats &&
        chatFolder.deletedAtTimestampMs === 0
    );
  });

export const getSelectedChatFolder: StateSelector<CurrentChatFolder | null> =
  createSelector(
    getChatFoldersState,
    getCurrentChatFolders,
    (state, currentChatFolders) => {
      const { selectedChatFolderId } = state;
      if (selectedChatFolderId == null) {
        return null;
      }
      return CurrentChatFolders.expect(
        currentChatFolders,
        selectedChatFolderId,
        'getSelectedChatFolder'
      );
    }
  );

export const getStableSelectedConversationIdInChatFolder: StateSelector<
  string | null
> = createSelector(getChatFoldersState, state => {
  return state.stableSelectedConversationIdInChatFolder;
});
