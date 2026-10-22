// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect } from 'react';
import type { JSX } from 'react';
import { useSelector } from 'react-redux';

import { trukiOnSignalConversationChanged } from '../../util/trukiBridgedSelection.std.ts';
import { useTrukiBridgeActions } from '../ducks/trukiBridge.preload.ts';
import { getTrukiSelectedChatId } from '../selectors/trukiBridge.std.ts';
import { SmartTrukiBridgedConversation } from './TrukiBridgedConversation.preload.tsx';

function renderTrukiConversation(chatId: string): JSX.Element {
  return <SmartTrukiBridgedConversation chatId={chatId} />;
}

// The chats tab's Truki props: the selected bridged chat and how to render
// it. Selecting a Signal conversation clears the bridged selection.
export function useTrukiChatsTabProps(
  selectedConversationId: string | undefined
): {
  trukiSelectedChatId: string | undefined;
  renderTrukiConversation: (chatId: string) => JSX.Element;
} {
  const trukiSelectedChatId = useSelector(getTrukiSelectedChatId);
  const { clearBridgedSelection } = useTrukiBridgeActions();

  useEffect(() => {
    trukiOnSignalConversationChanged(
      selectedConversationId,
      clearBridgedSelection
    );
  }, [selectedConversationId, clearBridgedSelection]);

  return { trukiSelectedChatId, renderTrukiConversation };
}
