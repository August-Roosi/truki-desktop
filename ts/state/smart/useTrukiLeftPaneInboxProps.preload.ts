// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useMemo } from 'react';
import { useSelector } from 'react-redux';

import type { PropsType as LeftPanePropsType } from '../../components/LeftPane.dom.tsx';
import { LeftPaneMode } from '../../types/leftPane.std.ts';
import { trukiSelectBridgedChat } from '../../util/trukiBridgedSelection.std.ts';
import { useConversationsActions } from '../ducks/conversations.preload.ts';
import { useTrukiBridgeActions } from '../ducks/trukiBridge.preload.ts';
import {
  getTrukiBridge,
  getTrukiChatList,
  getTrukiSelectedChatId,
} from '../selectors/trukiBridge.std.ts';

type ModeSpecificProps = LeftPanePropsType['modeSpecificProps'];

// The bridge's mute is a time; "muted" with no end is the far future.
export const TRUKI_MUTED_FOREVER = Date.UTC(9999, 11, 31);

// Account states (mautrix bridge states) in which the account's chats cannot
// send or receive.
const DISCONNECTED_STATES: ReadonlySet<string> = new Set([
  'TRANSIENT_DISCONNECT',
  'BAD_CREDENTIALS',
  'UNKNOWN_ERROR',
  'LOGGED_OUT',
]);

// Starts the bridge client once and adds the bridged chats to the left
// pane's inbox props. Every other mode, and an inbox without bridged chats,
// gets its props back untouched.
export function useTrukiLeftPaneInboxProps(
  modeSpecificProps: ModeSpecificProps
): ModeSpecificProps {
  // Unfiltered until Spaces filter bridged chats (Task 11).
  const chats = useSelector(getTrukiChatList);
  const selectedChatId = useSelector(getTrukiSelectedChatId);
  const accounts = useSelector(getTrukiBridge).accounts;
  const { trukiBridgeStart, selectBridgedChat, markRead, setMuted } =
    useTrukiBridgeActions();
  const { showConversation } = useConversationsActions();

  useEffect(() => {
    trukiBridgeStart();
  }, [trukiBridgeStart]);

  const disconnectedLoginIds = useMemo(
    () =>
      accounts
        .filter(account => DISCONNECTED_STATES.has(account.state))
        .map(account => account.loginId),
    [accounts]
  );

  const onSelectTrukiChat = useCallback(
    (chatId: string) => {
      trukiSelectBridgedChat(chatId, { showConversation, selectBridgedChat });
    },
    [showConversation, selectBridgedChat]
  );

  const onTrukiChatMarkRead = useCallback(
    (chatId: string) => {
      const eventId = chats.find(chat => chat.id === chatId)?.lastEventId;
      if (eventId) {
        void markRead(chatId, eventId);
      }
    },
    [chats, markRead]
  );

  const onTrukiChatSetMuted = useCallback(
    (chatId: string, muted: boolean) => {
      void setMuted(chatId, muted ? TRUKI_MUTED_FOREVER : undefined);
    },
    [setMuted]
  );

  return useMemo(() => {
    if (modeSpecificProps.mode !== LeftPaneMode.Inbox || chats.length === 0) {
      return modeSpecificProps;
    }
    const trukiBridgedChats = modeSpecificProps.filterByUnread
      ? chats.filter(chat => chat.unreadCount > 0)
      : chats;
    return {
      ...modeSpecificProps,
      trukiBridgedChats,
      trukiSelectedChatId: selectedChatId,
      trukiDisconnectedLoginIds: disconnectedLoginIds,
      onSelectTrukiChat,
      onTrukiChatMarkRead,
      onTrukiChatSetMuted,
    };
  }, [
    modeSpecificProps,
    chats,
    selectedChatId,
    disconnectedLoginIds,
    onSelectTrukiChat,
    onTrukiChatMarkRead,
    onTrukiChatSetMuted,
  ]);
}
