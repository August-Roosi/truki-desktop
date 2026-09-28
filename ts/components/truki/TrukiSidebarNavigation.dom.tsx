// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX, ReactNode } from 'react';
import { createContext, useContext } from 'react';

import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import { NavTab } from '../../types/Nav.std.ts';
import type { LocalizerType } from '../../types/Util.std.ts';
import type { UnreadCountBadgeType } from '../../types/StorageKeys.std.ts';
import type { UnreadStats } from '../../util/countUnreadStats.std.ts';
import { getUnreadCountForBadge } from '../../util/countUnreadStats.std.ts';

type TrukiSidebarNavigationContextType = Readonly<{
  hasFailedStorySends: boolean;
  hasPendingUpdate: boolean;
  i18n: LocalizerType;
  onSelectTab: (tab: NavTab) => void;
  selectedNavTab: NavTab;
  storiesEnabled: boolean;
  unreadCallsCount: number;
  unreadConversationsStats: UnreadStats;
  unreadCountBadgeType: UnreadCountBadgeType;
  unreadStoriesCount: number;
}>;

const TrukiSidebarNavigationContext =
  createContext<TrukiSidebarNavigationContextType | null>(null);

type TrukiSidebarNavigationProviderProps = TrukiSidebarNavigationContextType &
  Readonly<{
    children: ReactNode;
  }>;

export function TrukiSidebarNavigationProvider({
  children,
  ...value
}: TrukiSidebarNavigationProviderProps): JSX.Element {
  return (
    <TrukiSidebarNavigationContext.Provider value={value}>
      {children}
    </TrukiSidebarNavigationContext.Provider>
  );
}

export function useTrukiSidebarNavigationVisible(): boolean {
  const value = useContext(TrukiSidebarNavigationContext);
  return value != null && value.selectedNavTab !== NavTab.Settings;
}

type TrukiNavigationButtonProps = Readonly<{
  badgeCount?: number;
  hasError?: boolean;
  isSelected: boolean;
  label: string;
  onClick: () => void;
  symbol: 'message' | 'phone' | 'settings' | 'stories';
}>;

function TrukiNavigationButton({
  badgeCount = 0,
  hasError = false,
  isSelected,
  label,
  onClick,
  symbol,
}: TrukiNavigationButtonProps): JSX.Element {
  return (
    <span className={tw('relative flex justify-center')}>
      <AxoIconButton.Root
        label={label}
        variant={isSelected ? 'subtle-secondary' : 'implied-secondary'}
        size="lg"
        symbol={symbol}
        pressed={isSelected}
        onClick={onClick}
      />
      {(hasError || badgeCount > 0) && (
        <span
          aria-hidden
          className={tw(
            'absolute inset-s-1/2 -top-0.5 ms-2.5 flex h-4 min-w-4 items-center justify-center rounded-full',
            'bg-destructive px-0.5 type-caption font-semibold text-primary-oncolor'
          )}
        >
          {hasError ? '!' : badgeCount}
        </span>
      )}
    </span>
  );
}

export function TrukiSidebarNavigation(): JSX.Element | null {
  const value = useContext(TrukiSidebarNavigationContext);
  if (value == null || value.selectedNavTab === NavTab.Settings) {
    return null;
  }

  const chatsUnreadCount = getUnreadCountForBadge(
    value.unreadConversationsStats,
    value.unreadCountBadgeType
  );

  return (
    <nav
      className={tw(
        'absolute inset-x-0 bottom-5 z-10 mx-auto w-[214px]',
        'rounded-[18px] border border-primary p-2.5',
        'shadow-elevation-2 backdrop-blur-thin'
      )}
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--axo-color-surface-primary) 72%, transparent)',
      }}
    >
      <div className={tw('flex items-center justify-around gap-2')}>
        <TrukiNavigationButton
          badgeCount={chatsUnreadCount}
          isSelected={value.selectedNavTab === NavTab.Chats}
          label={value.i18n('icu:NavTabs__ItemLabel--Chats')}
          onClick={() => value.onSelectTab(NavTab.Chats)}
          symbol="message"
        />
        <TrukiNavigationButton
          badgeCount={value.unreadCallsCount}
          isSelected={value.selectedNavTab === NavTab.Calls}
          label={value.i18n('icu:NavTabs__ItemLabel--Calls')}
          onClick={() => value.onSelectTab(NavTab.Calls)}
          symbol="phone"
        />
        {value.storiesEnabled && (
          <TrukiNavigationButton
            badgeCount={value.unreadStoriesCount}
            hasError={value.hasFailedStorySends}
            isSelected={value.selectedNavTab === NavTab.Stories}
            label={value.i18n('icu:NavTabs__ItemLabel--Stories')}
            onClick={() => value.onSelectTab(NavTab.Stories)}
            symbol="stories"
          />
        )}
      </div>
      <div
        className={tw(
          'mt-2.5 flex justify-center border-t border-primary pt-2.5'
        )}
      >
        <span className={tw('relative flex justify-center')}>
          <AxoIconButton.Root
            label={value.i18n('icu:NavTabs__ItemLabel--Settings')}
            variant="implied-secondary"
            size="lg"
            symbol="settings"
            onClick={() => value.onSelectTab(NavTab.Settings)}
          />
          {value.hasPendingUpdate && (
            <span
              aria-hidden
              className={tw(
                'absolute inset-e-0.5 top-0.5 size-2 rounded-full border border-secondary bg-accent'
              )}
            />
          )}
        </span>
      </div>
    </nav>
  );
}
