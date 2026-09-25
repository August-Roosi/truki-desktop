// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { action } from '@storybook/addon-actions';
import type { Meta } from '@storybook/react';

import { TrukiSpaceBar } from './TrukiSpaceBar.dom.tsx';
import {
  CHAT_FOLDER_DEFAULTS,
  ChatFolderType,
  type ChatFolderId,
} from '../../types/ChatFolder.std.ts';
import {
  CurrentChatFolders,
  type CurrentChatFolder,
} from '../../types/CurrentChatFolders.std.ts';
import type { UnreadStats } from '../../util/countUnreadStats.std.ts';
import type { MutedStats } from '../../util/countMutedStats.std.ts';
import * as TrukiSpaceColor from '../../types/TrukiSpaceColor.std.ts';

const { i18n } = window.SignalContext;

export default {
  title: 'Components/LeftPane/TrukiSpaceBar',
} satisfies Meta;

type SpaceOptions = Readonly<{
  id: string;
  folderType: ChatFolderType.ALL | ChatFolderType.CUSTOM;
  position: number;
  name?: string;
  emoji?: string | null;
  color?: number | null;
}>;

function makeSpace(options: SpaceOptions): CurrentChatFolder {
  return {
    ...CHAT_FOLDER_DEFAULTS,
    id: options.id as ChatFolderId,
    folderType: options.folderType,
    position: options.position,
    name: options.name ?? '',
    emoji: options.emoji ?? null,
    color: options.color ?? null,
    deletedAtTimestampMs: 0,
    storageID: null,
    storageVersion: null,
    storageUnknownFields: null,
    storageNeedsSync: false,
  };
}

function getPaletteColor(key: string): number {
  const color = TrukiSpaceColor.PALETTE.find(option => option.key === key);
  if (color == null) {
    throw new Error(`Unknown Truki space colour: ${key}`);
  }
  return color.value;
}

const general = makeSpace({
  id: 'general',
  folderType: ChatFolderType.ALL,
  position: 0,
});

const work = makeSpace({
  id: 'work',
  folderType: ChatFolderType.CUSTOM,
  position: 1,
  name: 'Work',
  emoji: '💼',
});

const hobbies = makeSpace({
  id: 'hobbies',
  folderType: ChatFolderType.CUSTOM,
  position: 2,
  name: 'Hobbies',
  emoji: '🎮',
});

const unreadStats: UnreadStats = {
  unreadCount: 3,
  unreadChatsCount: 1,
  unreadMentionsCount: 0,
  readChatsMarkedUnreadCount: 0,
};

const mutedStats: MutedStats = {
  chatsMutedCount: 0,
  chatsUnmutedCount: 1,
};

function renderSpaceBar(
  chatFolders: ReadonlyArray<CurrentChatFolder>,
  selectedChatFolder: CurrentChatFolder,
  allChatFoldersUnreadStats = new Map<ChatFolderId, UnreadStats>()
): JSX.Element {
  return (
    <div style={{ width: 360 }}>
      <TrukiSpaceBar
        i18n={i18n}
        navSidebarWidthBreakpoint={null}
        currentChatFolders={CurrentChatFolders.fromArray(chatFolders)}
        allChatFoldersUnreadStats={allChatFoldersUnreadStats}
        allChatFoldersMutedStats={
          new Map(chatFolders.map(chatFolder => [chatFolder.id, mutedStats]))
        }
        unreadCountBadgeType="unread-messages"
        selectedChatFolder={selectedChatFolder}
        onSelectedChatFolderIdChange={action('onSelectedChatFolderIdChange')}
        onChatFolderMarkRead={action('onChatFolderMarkRead')}
        onChatFolderUpdateMute={action('onChatFolderUpdateMute')}
        onChatFolderOpenSettings={action('onChatFolderOpenSettings')}
      />
    </div>
  );
}

export function Default(): JSX.Element {
  return renderSpaceBar(
    [general, work, hobbies],
    general,
    new Map([[hobbies.id, unreadStats]])
  );
}

export function WithColors(): JSX.Element {
  const greenWork = { ...work, color: getPaletteColor('green') };
  const purpleHobbies = {
    ...hobbies,
    color: getPaletteColor('purple'),
  };
  return renderSpaceBar([general, greenWork, purpleHobbies], greenWork);
}

export function NoEmoji(): JSX.Element {
  const gaming = makeSpace({
    id: 'gaming',
    folderType: ChatFolderType.CUSTOM,
    position: 1,
    name: 'Gaming',
    emoji: null,
  });
  return renderSpaceBar([general, gaming], general);
}

export function GeneralNotRenamed(): JSX.Element {
  return renderSpaceBar([general, work], work);
}

export function GeneralRenamed(): JSX.Element {
  const renamedGeneral = makeSpace({
    id: 'general',
    folderType: ChatFolderType.ALL,
    position: 0,
    name: 'Home',
    emoji: null,
  });
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {renderSpaceBar([renamedGeneral, work], work)}
      {renderSpaceBar([renamedGeneral, work], renamedGeneral)}
    </div>
  );
}

export function MultiCodepointEmoji(): JSX.Element {
  const family = makeSpace({
    id: 'family',
    folderType: ChatFolderType.CUSTOM,
    position: 1,
    name: 'Family',
    emoji: '👨‍👩‍👧‍👦',
  });
  const estonia = makeSpace({
    id: 'estonia',
    folderType: ChatFolderType.CUSTOM,
    position: 2,
    name: '🇪🇪Eesti',
    emoji: null,
  });
  return renderSpaceBar([general, family, estonia], general);
}

export function LongName(): JSX.Element {
  const longName = makeSpace({
    id: 'long-name',
    folderType: ChatFolderType.CUSTOM,
    position: 1,
    name: 'Long space label with 32 chars!!',
    emoji: '📚',
  });
  return renderSpaceBar([general, longName], longName);
}

export function ManySpaces(): JSX.Element {
  const spaces = Array.from({ length: 10 }, (_, index) => {
    return makeSpace({
      id: `space-${index}`,
      folderType: ChatFolderType.CUSTOM,
      position: index + 1,
      name: `Space ${index + 1}`,
      emoji: null,
    });
  });
  return renderSpaceBar([general, ...spaces], general);
}
