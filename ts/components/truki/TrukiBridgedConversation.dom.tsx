// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useMemo, useState } from 'react';
import type { JSX } from 'react';

import type { TrukiSupervisorStateName } from '../../../app/truki/trukiBridgeProtocol.std.ts';
import { AxoConfirmDialog } from '../../axo/AxoConfirmDialog.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type {
  TrukiBridgedChatSummary,
  TrukiBridgedEvent,
} from '../../state/ducks/trukiBridge.preload.ts';
import { useNowThatUpdatesEveryMinute } from '../../hooks/useNowThatUpdatesEveryMinute.std.ts';
import type { LocalizerType, ThemeType } from '../../types/Util.std.ts';
import {
  buildTrukiTimeline,
  getTrukiConversationBanner,
  TRUKI_RATE_LIMITED,
} from '../../util/trukiBridgedTimeline.std.ts';
import { TrukiBridgedComposer } from './TrukiBridgedComposer.dom.tsx';
import { TrukiBridgedConversationBanner } from './TrukiBridgedConversationBanner.dom.tsx';
import { TrukiBridgedConversationHeader } from './TrukiBridgedConversationHeader.dom.tsx';
import { getTrukiContentPreview } from './TrukiBridgedMessageBubble.dom.tsx';
import { TrukiBridgedTimeline } from './TrukiBridgedTimeline.dom.tsx';

export type TrukiBridgedConversationProps = Readonly<{
  i18n: LocalizerType;
  chatId: string;
  // Undefined when the chat is no longer in the bridge's list.
  chat: TrukiBridgedChatSummary | undefined;
  events: ReadonlyArray<TrukiBridgedEvent>;
  hasOlder: boolean;
  loading: boolean;
  localUserId: string;
  networkName: string;
  accountName?: string;
  bridgeState: TrukiSupervisorStateName;
  accountState?: string;
  typingUsers: ReadonlyArray<string>;
  error?: Readonly<{ code: string; message: string }>;
  theme?: ThemeType;
  onLoadOlder: () => void;
  onMarkRead: (eventId: string) => void;
  onSend: (text: string, replyTo: string | undefined) => void;
  onReact: (eventId: string, key: string) => void;
  onRedact: (eventId: string) => void;
  onRetry: (eventId: string) => void;
  onSetMuted: (muted: boolean) => void;
  onAttach: (
    caption: string | undefined,
    replyTo: string | undefined
  ) => Promise<boolean>;
  onDismissError: () => void;
  retriedEventIds?: ReadonlyArray<string>;
  onSaveMedia?: (mxc: string, suggestedName: string) => void;
  // Wired by the connected-accounts work (Task 10); hidden while undefined.
  onRestartBridge?: () => void;
  onReconnectAccount?: () => void;
}>;

// A bridged chat (WhatsApp, Messenger, ...) in the conversation panel:
// header, status banners, timeline and composer. See spec §4.2 and §7.
export const TrukiBridgedConversation = memo(function TrukiBridgedConversation({
  i18n,
  chat,
  events,
  hasOlder,
  loading,
  localUserId,
  networkName,
  accountName,
  bridgeState,
  accountState,
  typingUsers,
  error,
  theme,
  onLoadOlder,
  onMarkRead,
  onSend,
  onReact,
  onRedact,
  onRetry,
  onSetMuted,
  onAttach,
  onDismissError,
  retriedEventIds,
  onSaveMedia,
  onRestartBridge,
  onReconnectAccount,
}: TrukiBridgedConversationProps): JSX.Element {
  const [replyToId, setReplyToId] = useState<string | undefined>();
  const [redactId, setRedactId] = useState<string | undefined>();
  const now = useNowThatUpdatesEveryMinute();

  const items = useMemo(
    () => buildTrukiTimeline(events, localUserId),
    [events, localUserId]
  );

  const replyItem = replyToId
    ? items.find(item => item.id === replyToId && !item.redacted)
    : undefined;

  const handleSend = useCallback(
    (text: string) => {
      onSend(text, replyItem?.id);
      setReplyToId(undefined);
    },
    [onSend, replyItem?.id]
  );

  const handleAttach = useCallback(
    async (caption: string | undefined) => {
      const sent = await onAttach(caption, replyItem?.id);
      if (sent) {
        setReplyToId(undefined);
      }
      return sent;
    },
    [onAttach, replyItem?.id]
  );

  const handleCancelReply = useCallback(() => setReplyToId(undefined), []);
  const handleRemoveReaction = useCallback(
    (reactionEventId: string) => onRedact(reactionEventId),
    [onRedact]
  );
  const handleRedactOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setRedactId(undefined);
    }
  }, []);
  const handleConfirmRedact = useCallback(() => {
    if (redactId) {
      onRedact(redactId);
    }
    setRedactId(undefined);
  }, [onRedact, redactId]);

  if (!chat) {
    return (
      <div
        className={tw(
          'flex size-full items-center justify-center bg-surface-primary p-8'
        )}
      >
        <p className={tw('text-center type-body-large text-secondary')}>
          {i18n('icu:TrukiBridgedConversation__Unavailable')}
        </p>
      </div>
    );
  }

  const bannerKind = getTrukiConversationBanner(bridgeState, accountState);
  const canAct = bannerKind === undefined;
  const isMuted = chat.mutedUntil !== undefined && chat.mutedUntil > now;
  const otherName = chat.isDM ? chat.name : networkName;
  const isTyping = typingUsers.some(user => user !== localUserId);

  let banner: JSX.Element | undefined;
  if (bannerKind === 'bridge-starting') {
    banner = (
      <TrukiBridgedConversationBanner
        i18n={i18n}
        tone="info"
        text={i18n('icu:TrukiBridgedConversation__BridgeStarting')}
      />
    );
  } else if (bannerKind === 'bridge-down') {
    banner = (
      <TrukiBridgedConversationBanner
        i18n={i18n}
        tone="warning"
        text={i18n('icu:TrukiBridgedConversation__BridgeDown')}
        action={
          onRestartBridge
            ? {
                label: i18n('icu:TrukiBridgedConversation__Restart'),
                onClick: onRestartBridge,
              }
            : undefined
        }
      />
    );
  } else if (bannerKind === 'logged-out') {
    banner = (
      <TrukiBridgedConversationBanner
        i18n={i18n}
        tone="warning"
        text={i18n('icu:TrukiBridgedConversation__LoggedOut', {
          network: networkName,
        })}
        action={
          onReconnectAccount
            ? {
                label: i18n('icu:TrukiBridgedConversation__Reconnect'),
                onClick: onReconnectAccount,
              }
            : undefined
        }
      />
    );
  }

  return (
    <div
      className={tw('flex size-full flex-col bg-surface-primary')}
      data-testid="TrukiBridgedConversation"
    >
      <TrukiBridgedConversationHeader
        i18n={i18n}
        name={chat.name}
        networkName={networkName}
        accountName={accountName}
        isMuted={isMuted}
        onSetMuted={onSetMuted}
      />
      {banner}
      {error && (
        <TrukiBridgedConversationBanner
          i18n={i18n}
          tone="error"
          text={
            error.code === TRUKI_RATE_LIMITED
              ? i18n('icu:TrukiBridgedConversation__RateLimited', {
                  network: networkName,
                })
              : i18n('icu:TrukiBridgedConversation__Error')
          }
          onDismiss={onDismissError}
        />
      )}
      <TrukiBridgedTimeline
        i18n={i18n}
        items={items}
        hasOlder={hasOlder}
        loading={loading}
        isTyping={isTyping}
        otherName={otherName}
        networkName={networkName}
        canAct={canAct}
        theme={theme}
        onLoadOlder={onLoadOlder}
        onReachBottom={onMarkRead}
        onReply={setReplyToId}
        onReact={onReact}
        onRemoveReaction={handleRemoveReaction}
        onRequestRedact={setRedactId}
        onRetry={onRetry}
        retriedEventIds={retriedEventIds}
        onSaveFile={onSaveMedia}
      />
      <TrukiBridgedComposer
        i18n={i18n}
        disabled={!canAct}
        replyPreview={
          replyItem
            ? {
                author: replyItem.outgoing
                  ? i18n('icu:TrukiBridgedConversation__You')
                  : otherName,
                text: getTrukiContentPreview(i18n, replyItem.content),
              }
            : undefined
        }
        onCancelReply={handleCancelReply}
        onSend={handleSend}
        onAttach={handleAttach}
      />
      <AxoConfirmDialog.Root
        open={redactId !== undefined}
        onOpenChange={handleRedactOpenChange}
        title={i18n('icu:TrukiBridgedConversation__DeleteTitle')}
        description={i18n('icu:TrukiBridgedConversation__DeleteDescription', {
          network: networkName,
        })}
      >
        <AxoConfirmDialog.Cancel />
        <AxoConfirmDialog.Action
          variant="strong-destructive"
          onClick={handleConfirmRedact}
        >
          {i18n('icu:DeleteMessagesModal--deleteForEveryone')}
        </AxoConfirmDialog.Action>
      </AxoConfirmDialog.Root>
    </div>
  );
});
