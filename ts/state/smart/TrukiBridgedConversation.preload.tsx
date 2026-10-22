// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useSelector } from 'react-redux';

import { TrukiBridgedConversation } from '../../components/truki/TrukiBridgedConversation.dom.tsx';
import { trukiPickAttachment } from '../../services/trukiBridgeClient.preload.ts';
import { getTrukiNetworkDisplayName } from '../../util/trukiBridgedTimeline.std.ts';
import {
  TRUKI_BRIDGE_LOCAL_USER,
  useTrukiBridgeActions,
} from '../ducks/trukiBridge.preload.ts';
import { getTrukiBridge } from '../selectors/trukiBridge.std.ts';
import { getIntl, getTheme } from '../selectors/user.std.ts';
import { TRUKI_MUTED_FOREVER } from './useTrukiLeftPaneInboxProps.preload.ts';

const NO_EVENTS = [] as const;
const NO_USERS = [] as const;

export type SmartTrukiBridgedConversationProps = Readonly<{
  chatId: string;
}>;

export const SmartTrukiBridgedConversation = memo(
  function SmartTrukiBridgedConversation({
    chatId,
  }: SmartTrukiBridgedConversationProps): JSX.Element {
    const i18n = useSelector(getIntl);
    const theme = useSelector(getTheme);
    const bridge = useSelector(getTrukiBridge);
    const {
      clearBridgeError,
      loadOlderMessages,
      markRead,
      redactMessage,
      retrySend,
      sendReaction,
      sendText,
      setMuted,
    } = useTrukiBridgeActions();

    // A failed attachment pick, shown like a failed request.
    const [attachError, setAttachError] = useState<
      { code: string; message: string } | undefined
    >();
    const lastMarkedRef = useRef<string | undefined>(undefined);

    const chat = bridge.chats[chatId];
    const entry = bridge.messagesByChat[chatId];
    const account = chat
      ? bridge.accounts.find(
          a => a.loginId === chat.loginId && a.network === chat.network
        )
      : undefined;
    const unreadCount = chat?.unreadCount ?? 0;

    const onLoadOlder = useCallback(() => {
      void loadOlderMessages(chatId);
    }, [chatId, loadOlderMessages]);

    const onMarkRead = useCallback(
      (eventId: string) => {
        if (unreadCount === 0 || lastMarkedRef.current === eventId) {
          return;
        }
        lastMarkedRef.current = eventId;
        void markRead(chatId, eventId);
      },
      [chatId, markRead, unreadCount]
    );

    const onSend = useCallback(
      (text: string, replyTo: string | undefined) => {
        void sendText(chatId, text, replyTo);
      },
      [chatId, sendText]
    );

    const onReact = useCallback(
      (eventId: string, key: string) => {
        void sendReaction(chatId, eventId, key);
      },
      [chatId, sendReaction]
    );

    const onRedact = useCallback(
      (eventId: string) => {
        void redactMessage(chatId, eventId);
      },
      [chatId, redactMessage]
    );

    const onRetry = useCallback(
      (eventId: string) => {
        void retrySend(chatId, eventId);
      },
      [chatId, retrySend]
    );

    const onSetMuted = useCallback(
      (muted: boolean) => {
        void setMuted(chatId, muted ? TRUKI_MUTED_FOREVER : undefined);
      },
      [chatId, setMuted]
    );

    const onAttach = useCallback(
      async (caption: string | undefined, replyTo: string | undefined) => {
        const result = await trukiPickAttachment({
          chatId,
          ...(caption ? { caption } : {}),
          ...(replyTo ? { replyTo } : {}),
        });
        if (!result.ok) {
          setAttachError({
            code: result.bridgeCode ?? result.code,
            message: result.message,
          });
          return false;
        }
        return 'eventId' in result.value;
      },
      [chatId]
    );

    const onDismissError = useCallback(() => {
      setAttachError(undefined);
      clearBridgeError();
    }, [clearBridgeError]);

    const error = attachError ?? bridge.lastError;

    return (
      <TrukiBridgedConversation
        i18n={i18n}
        chatId={chatId}
        chat={chat}
        events={entry?.events ?? NO_EVENTS}
        hasOlder={entry?.hasOlder ?? false}
        loading={entry?.loading ?? false}
        localUserId={TRUKI_BRIDGE_LOCAL_USER}
        networkName={getTrukiNetworkDisplayName(
          chat?.network ?? '',
          bridge.networks
        )}
        accountName={account?.remoteName || undefined}
        bridgeState={bridge.bridgeState}
        accountState={account?.state}
        typingUsers={bridge.typingByChat[chatId] ?? NO_USERS}
        error={error}
        theme={theme}
        onLoadOlder={onLoadOlder}
        onMarkRead={onMarkRead}
        onSend={onSend}
        onReact={onReact}
        onRedact={onRedact}
        onRetry={onRetry}
        onSetMuted={onSetMuted}
        onAttach={onAttach}
        onDismissError={onDismissError}
      />
    );
  }
);
