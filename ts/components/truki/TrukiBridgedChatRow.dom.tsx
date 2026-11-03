// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback } from 'react';
import type { JSX, ReactNode } from 'react';

import { mxcToTrukiMediaUrl } from '../../../app/truki/trukiBridgeProtocol.std.ts';
import { AxoContextMenu } from '../../axo/AxoContextMenu.dom.tsx';
import { AxoSymbol } from '../../axo/AxoSymbol.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { TrukiBridgedChatSummary } from '../../state/ducks/trukiBridge.preload.ts';
import { AvatarColors, type AvatarColorType } from '../../types/Colors.std.ts';
import type { LocalizerType } from '../../types/Util.std.ts';
import { trukiChatInSpace } from '../../types/TrukiSpaceBridgedMembers.std.ts';
import { useTrukiAddToSpaceOptions } from './trukiAddToSpaceStore.std.ts';
import { BaseConversationListItem } from '../conversationList/BaseConversationListItem.dom.tsx';

// What a ConversationList row carries for a bridged chat (see
// RowType.TrukiBridgedChat); the list adds i18n.
export type TrukiBridgedChatRowDataType = Readonly<{
  chat: TrukiBridgedChatSummary;
  isSelected: boolean;
  // The chat's account is not connected to its network.
  isDisconnected?: boolean;
  onSelect: (chatId: string) => void;
  onMarkRead?: (chatId: string) => void;
  onSetMuted?: (chatId: string, muted: boolean) => void;
}>;

export type TrukiBridgedChatRowPropsType = TrukiBridgedChatRowDataType &
  Readonly<{
    i18n: LocalizerType;
  }>;

function isTrukiBridgedChatMuted(
  chat: TrukiBridgedChatSummary,
  now: number = Date.now()
): boolean {
  return chat.mutedUntil !== undefined && chat.mutedUntil > now;
}

function getNetworkMonogram(network: string): string {
  switch (network) {
    case 'whatsapp':
      return 'WA';
    case 'meta':
    case 'facebook':
    case 'messenger':
      return 'FB';
    case 'instagram':
      return 'IG';
    default:
      return network.slice(0, 2).toUpperCase();
  }
}

function getNetworkBadgeColor(network: string, isDisconnected: boolean) {
  if (isDisconnected) {
    return tw('bg-material-dim-secondary');
  }
  switch (network) {
    case 'whatsapp':
      return tw('bg-affirmative');
    case 'meta':
    case 'facebook':
    case 'messenger':
      return tw('bg-accent');
    case 'instagram':
      return tw('bg-safety');
    default:
      return tw('bg-material-dim-primary');
  }
}

// A stable avatar colour per chat, like Signal's per-conversation colour.
function getAvatarColor(chatId: string): AvatarColorType {
  let hash = 0;
  for (let i = 0; i < chatId.length; i += 1) {
    // oxlint-disable-next-line no-bitwise
    hash = (hash * 31 + chatId.charCodeAt(i)) | 0;
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  return AvatarColors[Math.abs(hash) % AvatarColors.length]!;
}

export const TrukiBridgedChatRow = memo(function TrukiBridgedChatRow({
  chat,
  i18n,
  isDisconnected = false,
  isSelected,
  onMarkRead,
  onSelect,
  onSetMuted,
}: TrukiBridgedChatRowPropsType): JSX.Element {
  const isMuted = isTrukiBridgedChatMuted(chat);
  const avatarUrl = chat.avatarMxc
    ? mxcToTrukiMediaUrl(chat.avatarMxc)
    : undefined;

  const handleClick = useCallback(() => {
    onSelect(chat.id);
  }, [onSelect, chat.id]);
  const handleMarkRead = useCallback(() => {
    onMarkRead?.(chat.id);
  }, [onMarkRead, chat.id]);
  const addToSpace = useTrukiAddToSpaceOptions();
  const handleToggleMute = useCallback(() => {
    onSetMuted?.(chat.id, !isMuted);
  }, [onSetMuted, chat.id, isMuted]);

  let previewText: string | undefined;
  if (chat.preview?.text) {
    previewText = chat.preview.fromMe
      ? i18n('icu:TrukiBridgedChatRow__PreviewFromMe', {
          text: chat.preview.text,
        })
      : chat.preview.text;
  }

  const headerName: ReactNode = (
    <span className={tw('flex min-w-0 items-center gap-1')}>
      <span className={tw('truncate')} dir="auto">
        {chat.name}
      </span>
      {isMuted && (
        <span className={tw('shrink-0 text-secondary')}>
          <AxoSymbol.InlineGlyph symbol="bell-slash" label={null} />
        </span>
      )}
    </span>
  );

  const disconnectedLabel = isDisconnected
    ? i18n('icu:TrukiBridgedChatRow__Disconnected')
    : undefined;

  const renderContextMenu = useCallback(
    ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => {
      const addToSpaceSpaces = addToSpace?.spaces ?? [];
      if (!onMarkRead && !onSetMuted && addToSpaceSpaces.length === 0) {
        return <>{children}</>;
      }
      return (
        <AxoContextMenu.Root>
          <AxoContextMenu.Trigger>{children}</AxoContextMenu.Trigger>
          <AxoContextMenu.Content>
            {onMarkRead && chat.unreadCount > 0 && chat.lastEventId && (
              <AxoContextMenu.Item
                symbol="message-check"
                onSelect={handleMarkRead}
              >
                {i18n('icu:markRead')}
              </AxoContextMenu.Item>
            )}
            {onSetMuted &&
              (isMuted ? (
                <AxoContextMenu.Item symbol="bell" onSelect={handleToggleMute}>
                  {i18n('icu:unmute')}
                </AxoContextMenu.Item>
              ) : (
                <AxoContextMenu.Item
                  symbol="bell-slash"
                  onSelect={handleToggleMute}
                >
                  {i18n('icu:muteNotificationsTitle')}
                </AxoContextMenu.Item>
              ))}
            {addToSpace != null && addToSpaceSpaces.length > 0 && (
              <AxoContextMenu.Sub>
                <AxoContextMenu.SubTrigger symbol="folder">
                  {i18n('icu:TrukiBridgedChatRow__AddToSpace')}
                </AxoContextMenu.SubTrigger>
                <AxoContextMenu.SubContent>
                  {addToSpaceSpaces.map(space => (
                    <AxoContextMenu.Item
                      key={space.id}
                      disabled={trukiChatInSpace(
                        chat,
                        addToSpace.members[space.id]
                      )}
                      onSelect={() => addToSpace.onAdd(space.id, chat.id)}
                    >
                      {space.name}
                    </AxoContextMenu.Item>
                  ))}
                </AxoContextMenu.SubContent>
              </AxoContextMenu.Sub>
            )}
          </AxoContextMenu.Content>
        </AxoContextMenu.Root>
      );
    },
    [
      addToSpace,
      chat,
      handleMarkRead,
      handleToggleMute,
      i18n,
      isMuted,
      onMarkRead,
      onSetMuted,
    ]
  );

  return (
    <div
      className={tw('relative', isMuted && 'opacity-60')}
      data-testid="TrukiBridgedChatRow"
    >
      <BaseConversationListItem
        id={chat.id}
        buttonAriaLabel={i18n('icu:ConversationList__aria-label', {
          lastMessage:
            previewText || i18n('icu:ConversationList__last-message-undefined'),
          title: chat.name,
          unreadCount: chat.unreadCount,
        })}
        conversationType={chat.isDM ? 'direct' : 'group'}
        color={getAvatarColor(chat.id)}
        avatarUrl={avatarUrl}
        headerDate={chat.lastActivity > 0 ? chat.lastActivity : undefined}
        headerName={headerName}
        i18n={i18n}
        isMe={false}
        isSelected={isSelected}
        messageText={previewText}
        onClick={handleClick}
        title={chat.name}
        unreadCount={chat.unreadCount}
        renderConversationListItemContextMenu={renderContextMenu}
      />
      <span
        aria-hidden={disconnectedLabel ? undefined : true}
        aria-label={disconnectedLabel}
        role={disconnectedLabel ? 'img' : undefined}
        title={disconnectedLabel}
        className={tw(
          // Only a disconnected badge takes the pointer, for its tooltip.
          disconnectedLabel ? 'pointer-events-auto' : 'pointer-events-none',
          'absolute inset-s-[44px] bottom-[10px]',
          'flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[3px]',
          'text-[8px] leading-none font-semibold text-primary-oncolor',
          getNetworkBadgeColor(chat.network, isDisconnected)
        )}
      >
        {getNetworkMonogram(chat.network)}
      </span>
    </div>
  );
});
