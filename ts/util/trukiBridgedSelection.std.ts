// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { ShowConversationType } from '../state/ducks/conversations.preload.ts';

// A bridged chat and a Signal conversation are never selected together:
// Signal's selection is cleared first, then the bridged chat is selected.
export function trukiSelectBridgedChat(
  chatId: string,
  actions: Readonly<{
    showConversation: ShowConversationType;
    selectBridgedChat: (chatId: string) => unknown;
  }>
): void {
  actions.showConversation({ conversationId: undefined });
  actions.selectBridgedChat(chatId);
}

// The other direction: once a Signal conversation is selected, the bridged
// selection is cleared. Called by the chats tab whenever Signal's selected
// conversation changes.
export function trukiOnSignalConversationChanged(
  selectedConversationId: string | undefined,
  clearBridgedSelection: () => unknown
): void {
  if (selectedConversationId !== undefined) {
    clearBridgedSelection();
  }
}
