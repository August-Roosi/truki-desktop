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
