// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { createSelector } from 'reselect';
import type { StateType } from '../reducer.preload.ts';
import type { StateSelector } from '../types.std.ts';
import type {
  TrukiBridgedChatSummary,
  TrukiBridgeStateType,
} from '../ducks/trukiBridge.preload.ts';

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
