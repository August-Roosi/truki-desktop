// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { MuteExpiration } from '@signalapp/types';

import {
  useCallback,
  useMemo,
  type FocusEvent,
  type JSX,
  type ReactNode,
} from 'react';

import { AxoBadge } from '../../axo/AxoBadge.dom.tsx';
import { AxoContextMenu } from '../../axo/AxoContextMenu.dom.tsx';
import { AxoSelect } from '../../axo/AxoSelect.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import {
  ChatFolderType,
  type ChatFolder,
  type ChatFolderId,
} from '../../types/ChatFolder.std.ts';
import { CurrentChatFolders } from '../../types/CurrentChatFolders.std.ts';
import type { LocalizerType } from '../../types/I18N.std.ts';
import type { UnreadCountBadgeType } from '../../types/StorageKeys.std.ts';
import * as TrukiSpaceColor from '../../types/TrukiSpaceColor.std.ts';
import type {
  AllChatFoldersMutedStats,
  MutedStats,
} from '../../util/countMutedStats.std.ts';
import type {
  AllChatFoldersUnreadStats,
  UnreadStats,
} from '../../util/countUnreadStats.std.ts';
import { getUnreadCountForBadge } from '../../util/countUnreadStats.std.ts';
import { getMuteValuesOptions } from '../../util/getMuteOptions.std.ts';
import * as grapheme from '../../util/grapheme.std.ts';
import { WidthBreakpoint } from '../_util.std.ts';
import { MuteNotificationsSubMenu } from '../MuteNotificationsMenu.dom.tsx';
import { UserText } from '../UserText.dom.tsx';

export type TrukiSpaceBarProps = Readonly<{
  i18n: LocalizerType;
  navSidebarWidthBreakpoint: WidthBreakpoint | null;
  currentChatFolders: CurrentChatFolders;
  allChatFoldersUnreadStats: AllChatFoldersUnreadStats;
  unreadCountBadgeType: UnreadCountBadgeType;
  allChatFoldersMutedStats: AllChatFoldersMutedStats;
  selectedChatFolder: ChatFolder | null;
  onSelectedChatFolderIdChange: (newValue: ChatFolderId) => void;
  onChatFolderMarkRead: (chatFolderId: ChatFolderId) => void;
  onChatFolderUpdateMute: (
    chatFolderId: ChatFolderId,
    muteExpiresAt: MuteExpiration
  ) => void;
  onChatFolderOpenSettings: (chatFolderId: ChatFolderId) => void;
}>;

function getBadgeValue(
  unreadStats: UnreadStats | null,
  unreadCountBadgeType: UnreadCountBadgeType
): number | null {
  if (unreadStats == null) {
    return null;
  }
  const total = getUnreadCountForBadge(unreadStats, unreadCountBadgeType);
  return total > 0 ? total : null;
}

function getChatFolderLabel(
  i18n: LocalizerType,
  chatFolder: ChatFolder,
  preferShort: boolean
): ReactNode {
  if (chatFolder.folderType === ChatFolderType.ALL) {
    if (preferShort) {
      return i18n('icu:LeftPaneChatFolders__ItemLabel--All--Short');
    }
    return i18n('icu:LeftPaneChatFolders__ItemLabel--All');
  }
  if (chatFolder.folderType === ChatFolderType.CUSTOM) {
    return <UserText text={chatFolder.name} />;
  }
  return '';
}

function getChatFolderDisplayLabel(
  i18n: LocalizerType,
  chatFolder: ChatFolder
): string {
  if (chatFolder.folderType === ChatFolderType.ALL) {
    return i18n('icu:LeftPaneChatFolders__ItemLabel--All');
  }
  return chatFolder.name;
}

function getChatFolderIconName(chatFolder: ChatFolder | null): 'message' | 'folder' {
  if (chatFolder == null) {
    return 'message';
  }

  return chatFolder.folderType === ChatFolderType.ALL ? 'message' : 'folder';
}

function getSpaceIcon(chatFolder: ChatFolder, label: string): string {
  if (chatFolder.emoji != null && chatFolder.emoji !== '') {
    return chatFolder.emoji;
  }
  // Must be grapheme-aware: 'label[0]' splits flags, ZWJ families and skin
  // tones into broken halves. truncateAndSize returns [text, size].
  const [firstGrapheme] = grapheme.truncateAndSize(label, 1);
  return firstGrapheme;
}

const UNREAD_BADGE_MAX_COUNT = 999;

export function TrukiSpaceBar(props: TrukiSpaceBarProps): JSX.Element | null {
  const { i18n, currentChatFolders, onSelectedChatFolderIdChange } = props;

  const sortedChatFolders = useMemo(() => {
    return CurrentChatFolders.toSortedArray(currentChatFolders);
  }, [currentChatFolders]);

  const handleValueChange = useCallback(
    (newValue: string | null) => {
      if (newValue != null) {
        onSelectedChatFolderIdChange(newValue as ChatFolderId);
      }
    },
    [onSelectedChatFolderIdChange]
  );

  const handleFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    event.target.scrollIntoView({
      behavior: 'smooth',
      inline: 'nearest',
    });
  }, []);

  if (!currentChatFolders.hasAnyCurrentCustomChatFolders) {
    return null;
  }

  if (props.navSidebarWidthBreakpoint === WidthBreakpoint.Narrow) {
    return (
      <div className={tw('min-w-0 flex-1')}>
        <AxoSelect.Root
          value={props.selectedChatFolder?.id ?? null}
          onValueChange={handleValueChange}
        >
          <AxoSelect.Trigger
            variant="elevated"
            width="full"
            placeholder=""
            chevron="on-hover"
          />
          <AxoSelect.Content position="dropdown">
            {sortedChatFolders.map(chatFolder => {
              const unreadStats =
                props.allChatFoldersUnreadStats.get(chatFolder.id) ?? null;
              return (
                <ChatFolderSelectItem
                  key={chatFolder.id}
                  i18n={i18n}
                  chatFolder={chatFolder}
                  unreadStats={unreadStats}
                  unreadCountBadgeType={props.unreadCountBadgeType}
                />
              );
            })}
          </AxoSelect.Content>
        </AxoSelect.Root>
      </div>
    );
  }

  return (
    <div
      className={tw(
        'flex min-w-0 flex-1 scrollbar-width-none gap-1 overflow-x-auto overflow-y-clip pe-2'
      )}
      onFocus={handleFocus}
    >
      {sortedChatFolders.map(chatFolder => {
        const unreadStats =
          props.allChatFoldersUnreadStats.get(chatFolder.id) ?? null;
        const mutedStats =
          props.allChatFoldersMutedStats.get(chatFolder.id) ?? null;
        return (
          <TrukiSpaceBarItem
            key={chatFolder.id}
            i18n={i18n}
            chatFolder={chatFolder}
            unreadStats={unreadStats}
            unreadCountBadgeType={props.unreadCountBadgeType}
            mutedStats={mutedStats}
            isSelected={props.selectedChatFolder?.id === chatFolder.id}
            onSelect={handleValueChange}
            onChatFolderMarkRead={props.onChatFolderMarkRead}
            onChatFolderUpdateMute={props.onChatFolderUpdateMute}
            onChatFolderOpenSettings={props.onChatFolderOpenSettings}
          />
        );
      })}
    </div>
  );
}

function ChatFolderSelectItem(props: {
  i18n: LocalizerType;
  chatFolder: ChatFolder;
  unreadStats: UnreadStats | null;
  unreadCountBadgeType: UnreadCountBadgeType;
}): JSX.Element {
  const { i18n, unreadStats, unreadCountBadgeType } = props;

  const badgeValue = useMemo(() => {
    return getBadgeValue(unreadStats, unreadCountBadgeType);
  }, [unreadStats, unreadCountBadgeType]);

  return (
    <AxoSelect.Item
      key={props.chatFolder.id}
      value={props.chatFolder.id}
      symbol={getChatFolderIconName(props.chatFolder)}
    >
      <AxoSelect.ItemText>
        {getChatFolderLabel(i18n, props.chatFolder, true)}
      </AxoSelect.ItemText>
      {badgeValue != null && (
        <AxoSelect.ItemBadge
          variant="primary"
          value={badgeValue}
          max={UNREAD_BADGE_MAX_COUNT}
          label={i18n(
            'icu:LeftPaneChatFolders__ItemUnreadBadge__AccessibleLabel',
            { count: badgeValue }
          )}
        />
      )}
    </AxoSelect.Item>
  );
}

function TrukiSpaceBarItem(props: {
  i18n: LocalizerType;
  chatFolder: ChatFolder;
  unreadStats: UnreadStats | null;
  unreadCountBadgeType: UnreadCountBadgeType;
  mutedStats: MutedStats | null;
  isSelected: boolean;
  onSelect: (newValue: string | null) => void;
  onChatFolderMarkRead: (chatFolderId: ChatFolderId) => void;
  onChatFolderUpdateMute: (
    chatFolderId: ChatFolderId,
    muteExpiresAt: MuteExpiration
  ) => void;
  onChatFolderOpenSettings: (chatFolderId: ChatFolderId) => void;
}): JSX.Element {
  const { i18n, chatFolder, isSelected, onSelect } = props;
  const label = getChatFolderDisplayLabel(i18n, chatFolder);
  const icon = getSpaceIcon(chatFolder, label);

  const badgeValue = useMemo(() => {
    return getBadgeValue(props.unreadStats, props.unreadCountBadgeType);
  }, [props.unreadCountBadgeType, props.unreadStats]);

  const handleClick = useCallback(() => {
    onSelect(chatFolder.id);
  }, [chatFolder.id, onSelect]);

  return (
    <TrukiSpaceBarItemContextMenu
      i18n={i18n}
      chatFolder={chatFolder}
      unreadStats={props.unreadStats}
      mutedStats={props.mutedStats}
      onChatFolderMarkRead={props.onChatFolderMarkRead}
      onChatFolderUpdateMute={props.onChatFolderUpdateMute}
      onChatFolderOpenSettings={props.onChatFolderOpenSettings}
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={isSelected}
        className={tw(
          'relative flex h-8 shrink-0 items-center gap-1 rounded-full px-2',
          'type-body-medium font-medium outline-focused-inner not-forced-colors:outline-none',
          'not-forced-colors:keyboard-mode:focus:axo-focus-ring',
          isSelected
            ? 'bg-accent text-primary-oncolor'
            : 'bg-primary text-primary hover:bg-secondary'
        )}
        style={
          isSelected && chatFolder.color != null
            ? { backgroundColor: TrukiSpaceColor.toCssHex(chatFolder.color) }
            : undefined
        }
        onClick={handleClick}
      >
        <span aria-hidden className={tw('leading-none')}>
          {icon}
        </span>
        {isSelected && (
          <span className={tw('max-w-[12ch] truncate')}>
            {getChatFolderLabel(i18n, chatFolder, false)}
          </span>
        )}
        {!isSelected && badgeValue != null && (
          <span className={tw('absolute -inset-e-1 -top-1')}>
            <AxoBadge.Root
              variant="primary"
              size="sm"
              value={badgeValue}
              max={UNREAD_BADGE_MAX_COUNT}
              label={i18n(
                'icu:LeftPaneChatFolders__ItemUnreadBadge__AccessibleLabel',
                { count: badgeValue }
              )}
            />
          </span>
        )}
      </button>
    </TrukiSpaceBarItemContextMenu>
  );
}

function TrukiSpaceBarItemContextMenu(props: {
  i18n: LocalizerType;
  chatFolder: ChatFolder;
  unreadStats: UnreadStats | null;
  mutedStats: MutedStats | null;
  onChatFolderMarkRead: (chatFolderId: ChatFolderId) => void;
  onChatFolderUpdateMute: (
    chatFolderId: ChatFolderId,
    muteExpiresAt: MuteExpiration
  ) => void;
  onChatFolderOpenSettings: (chatFolderId: ChatFolderId) => void;
  children: ReactNode;
}) {
  const {
    i18n,
    onChatFolderMarkRead,
    onChatFolderUpdateMute,
    onChatFolderOpenSettings,
  } = props;
  const chatFolderId = props.chatFolder.id;

  const muteValuesOptions = useMemo(() => {
    return getMuteValuesOptions(i18n);
  }, [i18n]);

  const someChatsUnread =
    (props.unreadStats?.unreadCount ?? 0) > 0 ||
    (props.unreadStats?.readChatsMarkedUnreadCount ?? 0) > 0;
  const someChatsMuted = (props.mutedStats?.chatsMutedCount ?? 0) > 0;
  const someChatsUnmuted = (props.mutedStats?.chatsUnmutedCount ?? 0) > 0;

  const showOnlyUnmuteAll = someChatsMuted && !someChatsUnmuted;

  const handleChatFolderMarkRead = useCallback(() => {
    onChatFolderMarkRead(chatFolderId);
  }, [chatFolderId, onChatFolderMarkRead]);

  const handleChatFolderUpdateMute = useCallback(
    (muteExpiresAt: MuteExpiration) => {
      onChatFolderUpdateMute(chatFolderId, muteExpiresAt);
    },
    [chatFolderId, onChatFolderUpdateMute]
  );

  const handleChatFolderUnmuteAll = useCallback(() => {
    onChatFolderUpdateMute(chatFolderId, MuteExpiration.UNMUTED);
  }, [chatFolderId, onChatFolderUpdateMute]);

  const handleChatFolderOpenSettings = useCallback(() => {
    onChatFolderOpenSettings(chatFolderId);
  }, [chatFolderId, onChatFolderOpenSettings]);

  return (
    <AxoContextMenu.Root>
      <AxoContextMenu.Trigger>{props.children}</AxoContextMenu.Trigger>
      <AxoContextMenu.Content>
        {someChatsUnread && (
          <AxoContextMenu.Item
            symbol="message-check"
            onSelect={handleChatFolderMarkRead}
          >
            {i18n('icu:LeftPaneChatFolders__Item__ContextMenu__MarkAllRead')}
          </AxoContextMenu.Item>
        )}
        {!showOnlyUnmuteAll && (
          <MuteNotificationsSubMenu
            i18n={i18n}
            renderer="AxoContextMenu"
            title={i18n(
              'icu:LeftPaneChatFolders__Item__ContextMenu__MuteNotifications'
            )}
            options={muteValuesOptions}
            onMuteExpiration={handleChatFolderUpdateMute}
          >
            {someChatsMuted && (
              <AxoContextMenu.Item onSelect={handleChatFolderUnmuteAll}>
                {i18n(
                  'icu:LeftPaneChatFolders__Item__ContextMenu__MuteNotifications__UnmuteAll'
                )}
              </AxoContextMenu.Item>
            )}
          </MuteNotificationsSubMenu>
        )}
        {showOnlyUnmuteAll && (
          <AxoContextMenu.Item
            symbol="bell"
            onSelect={handleChatFolderUnmuteAll}
          >
            {i18n('icu:LeftPaneChatFolders__Item__ContextMenu__UnmuteAll')}
          </AxoContextMenu.Item>
        )}
        {props.chatFolder.folderType === ChatFolderType.CUSTOM && (
          <AxoContextMenu.Item
            symbol="pencil"
            onSelect={handleChatFolderOpenSettings}
          >
            {i18n('icu:LeftPaneChatFolders__Item__ContextMenu__EditFolder')}
          </AxoContextMenu.Item>
        )}
      </AxoContextMenu.Content>
    </AxoContextMenu.Root>
  );
}
