// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useMemo } from 'react';
import { useSelector } from 'react-redux';

import type { PropsType as LeftPanePropsType } from '../../components/LeftPane.dom.tsx';
import { LeftPaneMode } from '../../types/leftPane.std.ts';
import { isTrukiAccountDisconnected } from '../../util/trukiAccountState.std.ts';
import { trukiSelectBridgedChat } from '../../util/trukiBridgedSelection.std.ts';
import { useConversationsActions } from '../ducks/conversations.preload.ts';
import { useTrukiBridgeActions } from '../ducks/trukiBridge.preload.ts';
import {
  getCurrentChatFolders,
  getSelectedChatFolder,
} from '../selectors/chatFolders.std.ts';
import {
  getTrukiBridge,
  getTrukiChatListForFolder,
  getTrukiSelectedChatId,
} from '../selectors/trukiBridge.std.ts';
import type { StateType } from '../reducer.preload.ts';
import {
  addTrukiChatToSpace,
  removeTrukiSpace,
} from '../../services/trukiSpaceMembers.preload.ts';
import { setTrukiAddToSpaceOptions } from '../../components/truki/trukiAddToSpaceStore.std.ts';
import { ChatFolderType } from '../../types/ChatFolder.std.ts';
import { CurrentChatFolders } from '../../types/CurrentChatFolders.std.ts';

type ModeSpecificProps = LeftPanePropsType['modeSpecificProps'];

// The bridge's mute is a time; "muted" with no end is the far future.
export const TRUKI_MUTED_FOREVER = Date.UTC(9999, 11, 31);

// Starts the bridge client once and adds the bridged chats to the left
// pane's inbox props. Every other mode, and an inbox without bridged chats,
// gets its props back untouched.
export function useTrukiLeftPaneInboxProps(
  modeSpecificProps: ModeSpecificProps
): ModeSpecificProps {
  // Bridged chats of the selected Space (General when nothing is selected).
  const selectedChatFolder = useSelector(getSelectedChatFolder);
  const chats = useSelector((state: StateType) =>
    getTrukiChatListForFolder(state, selectedChatFolder)
  );
  const selectedChatId = useSelector(getTrukiSelectedChatId);
  const accounts = useSelector(getTrukiBridge).accounts;
  const currentChatFolders = useSelector(getCurrentChatFolders);
  const spaceMembers = useSelector(
    (state: StateType) => state.items.trukiSpaceBridgedMembers
  );
  const { trukiBridgeStart, selectBridgedChat, markRead, setMuted } =
    useTrukiBridgeActions();
  const { showConversation } = useConversationsActions();

  useEffect(() => {
    trukiBridgeStart();
  }, [trukiBridgeStart]);

  // Deleting a Space has no action to subscribe to — deletions arrive as a
  // replacement of the folder list — so prune member entries for folder ids
  // that vanished whenever the folder list changes.
  useEffect(() => {
    const folderIds = new Set<string>(currentChatFolders.order);
    const vanishedFolderIds = Object.keys(spaceMembers ?? {}).filter(
      folderId => !folderIds.has(folderId)
    );
    if (vanishedFolderIds.length === 0) {
      return;
    }
    void (async () => {
      for (const folderId of vanishedFolderIds) {
        // Sequential on purpose: each removal re-reads the store, so
        // parallel puts would race over the same item.
        // oxlint-disable-next-line no-await-in-loop
        await removeTrukiSpace(folderId);
      }
    })();
  }, [currentChatFolders, spaceMembers]);

  // "Add to Space…" on a bridged chat row lists the custom Spaces.
  useEffect(() => {
    setTrukiAddToSpaceOptions({
      spaces: CurrentChatFolders.toSortedArray(currentChatFolders)
        .filter(folder => folder.folderType === ChatFolderType.CUSTOM)
        .map(folder => ({ id: folder.id, name: folder.name })),
      members: spaceMembers ?? {},
      onAdd: (spaceId, chatId) => {
        void addTrukiChatToSpace(spaceId, chatId);
      },
    });
  }, [currentChatFolders, spaceMembers]);
  useEffect(() => () => setTrukiAddToSpaceOptions(undefined), []);

  const disconnectedLoginIds = useMemo(
    () =>
      accounts
        .filter(account => isTrukiAccountDisconnected(account.state))
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
