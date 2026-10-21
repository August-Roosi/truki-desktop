// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { TrukiBridgedChatSummary } from '../state/ducks/trukiBridge.preload.ts';

// What the merge reads from a Signal row. The inbox passes ConversationList
// item props (ts/util may not import components, so the type is generic).
type TrukiSignalRowLike = Readonly<{ id: string; lastUpdated?: number }>;

export type TrukiMergedRow<Conversation extends TrukiSignalRowLike> =
  | { kind: 'signal'; conversation: Conversation }
  | { kind: 'truki'; chat: TrukiBridgedChatSummary };

function compareBridged(
  a: TrukiBridgedChatSummary,
  b: TrukiBridgedChatSummary
): number {
  if (a.lastActivity !== b.lastActivity) {
    return b.lastActivity - a.lastActivity;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

// Merges the bridged chats into Signal's unpinned list by activity, newest
// first (Signal: lastUpdated ?? 0; bridged: lastActivity). On equal times the
// Signal row comes first, then bridged rows by id. Signal's own order is kept
// as given: this is a merge, never a re-sort of Signal's list.
export function trukiMergeChatRows<Conversation extends TrukiSignalRowLike>(
  signal: ReadonlyArray<Conversation>,
  bridged: ReadonlyArray<TrukiBridgedChatSummary>
): ReadonlyArray<TrukiMergedRow<Conversation>> {
  const sortedBridged = [...bridged].sort(compareBridged);
  const result: Array<TrukiMergedRow<Conversation>> = [];

  let s = 0;
  let b = 0;
  while (s < signal.length || b < sortedBridged.length) {
    const conversation = signal[s];
    const chat = sortedBridged[b];
    if (
      conversation &&
      (!chat || (conversation.lastUpdated ?? 0) >= chat.lastActivity)
    ) {
      result.push({ kind: 'signal', conversation });
      s += 1;
    } else if (chat) {
      result.push({ kind: 'truki', chat });
      b += 1;
    }
  }

  return result;
}
