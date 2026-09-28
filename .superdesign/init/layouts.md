# Shared layouts

These files define the desktop application shell and its left-side navigation hierarchy.

## ts/components/App.dom.tsx

Root renderer that selects installer, standalone registration, inbox, or blank view.

```tsx
// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, type JSX } from 'react';

import { AppViewType } from '../types/app.std.ts';
import { missingCaseError } from '../util/missingCaseError.std.ts';
import { usePageVisibility } from '../hooks/usePageVisibility.dom.ts';
import { TitlebarDragArea } from './TitlebarDragArea.dom.tsx';
import { ThemeType } from '../types/Util.std.ts';

import type { ViewStoryActionCreatorType } from '../state/ducks/stories.preload.ts';
import type { AppStateType } from '../state/ducks/app.preload.ts';

type PropsType = {
  state: AppStateType;
  renderCallManager: () => JSX.Element;
  renderGlobalModalContainer: () => JSX.Element;
  hasSelectedStoryData: boolean;
  renderStandaloneRegistration: () => JSX.Element;
  renderStoryViewer: (closeView: () => unknown) => JSX.Element;
  renderInstallScreen: () => JSX.Element;
  renderLightbox: () => JSX.Element | null;
  theme: ThemeType;
  isMaximized: boolean;
  isFullScreen: boolean;
  osClassName: string;

  scrollToMessage: (conversationId: string, messageId: string) => unknown;
  viewStory: ViewStoryActionCreatorType;
  renderInbox: () => JSX.Element;
};

export function App({
  state,
  hasSelectedStoryData,
  isFullScreen,
  isMaximized,
  osClassName,
  renderCallManager,
  renderGlobalModalContainer,
  renderInbox,
  renderInstallScreen,
  renderLightbox,
  renderStandaloneRegistration,
  renderStoryViewer,
  theme,
  viewStory,
}: PropsType): JSX.Element {
  let contents;

  if (state.appView === AppViewType.Installer) {
    contents = renderInstallScreen();
  } else if (state.appView === AppViewType.Standalone) {
    contents = renderStandaloneRegistration();
  } else if (state.appView === AppViewType.Inbox) {
    contents = renderInbox();
  } else if (state.appView === AppViewType.Blank) {
    // See `background.html`
    contents = (
      <div className="app-loading-screen app-loading-screen--before-app-load">
        <TitlebarDragArea />

        <div className="module-splash-screen__logo module-splash-screen__logo--128" />
        <div className="dot-container">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
        <div className="message-placeholder" />
      </div>
    );
  } else {
    throw missingCaseError(state.appView);
  }

  // This are here so that themes are properly applied to anything that is
  // created in a portal and exists outside of the <App /> container.
  useEffect(() => {
    document.body.classList.remove('light-theme');
    document.body.classList.remove('dark-theme');

    if (theme === ThemeType.dark) {
      document.body.classList.add('dark-theme');
    }
    if (theme === ThemeType.light) {
      document.body.classList.add('light-theme');
    }
  }, [theme]);

  useEffect(() => {
    document.body.classList.add(osClassName);
  }, [osClassName]);

  useEffect(() => {
    document.body.classList.toggle('full-screen', isFullScreen);
    document.body.classList.toggle('maximized', isMaximized);
  }, [isFullScreen, isMaximized]);

  const isPageVisible = usePageVisibility();
  useEffect(() => {
    document.body.classList.toggle('page-is-visible', isPageVisible);
  }, [isPageVisible]);

  return (
    <div className="App">
      {contents}
      {renderGlobalModalContainer()}
      {renderCallManager()}
      {renderLightbox()}
      {hasSelectedStoryData &&
        renderStoryViewer(() => viewStory({ closeViewer: true }))}
    </div>
  );
}


```

## ts/components/Inbox.dom.tsx

Inbox shell that renders the navigation tabs and the selected tab panel.

```tsx
// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode, JSX } from 'react';
import type { SmartNavTabsProps } from '../state/smart/NavTabs.preload.tsx';
import { TitlebarDragArea } from './TitlebarDragArea.dom.tsx';

export type PropsType = {
  isCustomizingPreferredReactions: boolean;
  navTabsCollapsed: boolean;
  onToggleNavTabsCollapse: (navTabsCollapsed: boolean) => unknown;
  renderCallsTab: () => JSX.Element;
  renderChatsTab: () => JSX.Element;
  renderCustomizingPreferredReactionsModal: () => JSX.Element;
  renderNavTabs: (props: SmartNavTabsProps) => JSX.Element;
  renderStoriesTab: () => JSX.Element;
  renderSettingsTab: () => JSX.Element;
};

export function Inbox({
  isCustomizingPreferredReactions,
  navTabsCollapsed,
  onToggleNavTabsCollapse,
  renderCallsTab,
  renderChatsTab,
  renderCustomizingPreferredReactionsModal,
  renderNavTabs,
  renderStoriesTab,
  renderSettingsTab,
}: PropsType): JSX.Element {
  let activeModal: ReactNode;
  if (isCustomizingPreferredReactions) {
    activeModal = renderCustomizingPreferredReactionsModal();
  }

  return (
    <>
      <div className="Inbox">
        {renderNavTabs({
          navTabsCollapsed,
          onToggleNavTabsCollapse,
          renderChatsTab,
          renderCallsTab,
          renderStoriesTab,
          renderSettingsTab,
        })}
        <TitlebarDragArea />
      </div>
      {activeModal}
    </>
  );
}


```

## ts/state/smart/Inbox.preload.tsx

Smart composition for Chats, Calls, Stories, Settings, and collapse state.

```tsx
// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, type JSX } from 'react';
import { useSelector } from 'react-redux';
import { Inbox } from '../../components/Inbox.dom.tsx';
import { SmartCustomizingPreferredReactionsModal } from './CustomizingPreferredReactionsModal.preload.tsx';
import { getIsCustomizingPreferredReactions } from '../selectors/preferredReactions.std.ts';
import type { SmartNavTabsProps } from './NavTabs.preload.tsx';
import { SmartNavTabs } from './NavTabs.preload.tsx';
import { SmartStoriesTab } from './StoriesTab.preload.tsx';
import { SmartCallsTab } from './CallsTab.preload.tsx';
import { useItemsActions } from '../ducks/items.preload.ts';
import { getNavTabsCollapsed } from '../selectors/items.dom.ts';
import { SmartChatsTab } from './ChatsTab.preload.tsx';
import { SmartPreferences } from './Preferences.preload.tsx';

function renderChatsTab() {
  return <SmartChatsTab />;
}

function renderCallsTab() {
  return <SmartCallsTab />;
}

function renderCustomizingPreferredReactionsModal() {
  return <SmartCustomizingPreferredReactionsModal />;
}

function renderNavTabs(props: SmartNavTabsProps) {
  return <SmartNavTabs {...props} />;
}

function renderStoriesTab() {
  return <SmartStoriesTab />;
}

function renderSettingsTab() {
  return <SmartPreferences />;
}

export const SmartInbox = memo(function SmartInbox(): JSX.Element {
  const isCustomizingPreferredReactions = useSelector(
    getIsCustomizingPreferredReactions
  );
  const navTabsCollapsed = useSelector(getNavTabsCollapsed);

  const { toggleNavTabsCollapse } = useItemsActions();

  return (
    <Inbox
      isCustomizingPreferredReactions={isCustomizingPreferredReactions}
      navTabsCollapsed={navTabsCollapsed}
      onToggleNavTabsCollapse={toggleNavTabsCollapse}
      renderChatsTab={renderChatsTab}
      renderCallsTab={renderCallsTab}
      renderCustomizingPreferredReactionsModal={
        renderCustomizingPreferredReactionsModal
      }
      renderNavTabs={renderNavTabs}
      renderStoriesTab={renderStoriesTab}
      renderSettingsTab={renderSettingsTab}
    />
  );
});


```

## ts/components/NavTabs.dom.tsx

Current far-left vertical navigation rail and React Aria tab panels.

```tsx
// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { Key, ReactNode, JSX } from 'react';
import { Tabs, TabList, Tab, TabPanel } from 'react-aria-components';
import classNames from 'classnames';
import type { LocalizerType } from '../types/Util.std.ts';
import { NavTab, ProfileEditorPage, SettingsPage } from '../types/Nav.std.ts';
import type { Location } from '../types/Nav.std.ts';
import { Tooltip, TooltipPlacement } from './Tooltip.dom.tsx';
import { Theme } from '../util/theme.std.ts';
import type { UnreadStats } from '../util/countUnreadStats.std.ts';
import { getUnreadCountForBadge } from '../util/countUnreadStats.std.ts';
import type { UnreadCountBadgeType } from '../types/StorageKeys.std.ts';

type NavTabsItemBadgesProps = Readonly<{
  i18n: LocalizerType;
  hasError?: boolean;
  hasPendingUpdate?: boolean;
  unreadCount: number;
}>;

function NavTabsItemBadges({
  i18n,
  hasError,
  hasPendingUpdate,
  unreadCount,
}: NavTabsItemBadgesProps) {
  if (hasError) {
    return (
      <span className="NavTabs__ItemUnreadBadge">
        <span className="NavTabs__ItemIconLabel">
          {i18n('icu:NavTabs__ItemIconLabel--HasError')}
        </span>
        <span aria-hidden>!</span>
      </span>
    );
  }

  if (hasPendingUpdate) {
    return <div className="NavTabs__ItemUpdateBadge" />;
  }

  if (unreadCount > 0) {
    return (
      <span className="NavTabs__ItemUnreadBadge">
        <span className="NavTabs__ItemIconLabel">
          {i18n('icu:NavTabs__ItemIconLabel--UnreadCount', {
            count: unreadCount,
          })}
        </span>
        <span aria-hidden>{unreadCount}</span>
      </span>
    );
  }

  return null;
}

type NavTabProps = Readonly<{
  hasError?: boolean;
  i18n: LocalizerType;
  iconClassName: string;
  id: NavTab;
  label: string;
  navTabClassName: string;
  unreadCount: number;
  hasPendingUpdate?: boolean;
}>;

function NavTabsItem({
  hasError,
  i18n,
  iconClassName,
  id,
  label,
  navTabClassName,
  unreadCount,
  hasPendingUpdate,
}: NavTabProps) {
  const isRTL = i18n.getLocaleDirection() === 'rtl';
  return (
    <Tab
      id={id}
      data-testid={`NavTabsItem--${id}`}
      className={classNames('NavTabs__Item', navTabClassName)}
    >
      <span className="NavTabs__ItemLabel">{label}</span>
      <Tooltip
        content={label}
        theme={Theme.Dark}
        direction={isRTL ? TooltipPlacement.Left : TooltipPlacement.Right}
        delay={600}
      >
        <span className="NavTabs__ItemButton">
          <span className="NavTabs__ItemContent">
            <span
              role="presentation"
              className={`NavTabs__ItemIcon ${iconClassName}`}
            />
            <NavTabsItemBadges
              i18n={i18n}
              unreadCount={unreadCount}
              hasError={hasError}
              hasPendingUpdate={hasPendingUpdate}
            />
          </span>
        </span>
      </Tooltip>
    </Tab>
  );
}

export type NavTabPanelProps = Readonly<{
  otherTabsUnreadCount: number;
  collapsed: boolean;
  hasFailedStorySends: boolean;
  hasPendingUpdate: boolean;
  onToggleCollapse: (collapsed: boolean) => void;
}>;

export type NavTabsToggleProps = Readonly<{
  otherTabsUnreadCount: number;
  i18n: LocalizerType;
  hasFailedStorySends: boolean;
  hasPendingUpdate: boolean;
  navTabsCollapsed: boolean;
  onToggleNavTabsCollapse: (navTabsCollapsed: boolean) => void;
}>;

export function NavTabsToggle({
  i18n,
  hasFailedStorySends,
  hasPendingUpdate,
  navTabsCollapsed,
  otherTabsUnreadCount,
  onToggleNavTabsCollapse,
}: NavTabsToggleProps): JSX.Element {
  function handleToggle() {
    onToggleNavTabsCollapse(!navTabsCollapsed);
  }
  const label = navTabsCollapsed
    ? i18n('icu:NavTabsToggle__showTabs')
    : i18n('icu:NavTabsToggle__hideTabs');
  const isRTL = i18n.getLocaleDirection() === 'rtl';
  return (
    // FIXME
    // oxlint-disable-next-line jsx-a11y/control-has-associated-label
    <button
      type="button"
      className="NavTabs__Item NavTabs__Toggle"
      onClick={handleToggle}
    >
      <Tooltip
        content={label}
        theme={Theme.Dark}
        direction={isRTL ? TooltipPlacement.Left : TooltipPlacement.Right}
        delay={600}
      >
        <span className="NavTabs__ItemButton">
          <span className="NavTabs__ItemContent">
            <span
              role="presentation"
              className="NavTabs__ItemIcon NavTabs__ItemIcon--Menu"
            />
            <span className="NavTabs__ItemLabel">{label}</span>
            <NavTabsItemBadges
              i18n={i18n}
              unreadCount={otherTabsUnreadCount}
              hasError={hasFailedStorySends}
              hasPendingUpdate={hasPendingUpdate}
            />
          </span>
        </span>
      </Tooltip>
    </button>
  );
}

export type NavTabsProps = Readonly<{
  hasFailedStorySends: boolean;
  hasPendingUpdate: boolean;
  i18n: LocalizerType;
  navTabsCollapsed: boolean;
  onChangeLocation: (location: Location) => void;
  onToggleNavTabsCollapse: (collapsed: boolean) => void;
  renderCallsTab: () => ReactNode;
  renderChatsTab: () => ReactNode;
  renderStoriesTab: () => ReactNode;
  renderSettingsTab: () => ReactNode;
  selectedNavTab: NavTab;
  storiesEnabled: boolean;
  unreadCallsCount: number;
  unreadConversationsStats: UnreadStats;
  unreadCountBadgeType: UnreadCountBadgeType;
  unreadStoriesCount: number;
}>;

export function NavTabs({
  hasFailedStorySends,
  hasPendingUpdate,
  i18n,
  navTabsCollapsed,
  onChangeLocation,
  onToggleNavTabsCollapse,
  renderCallsTab,
  renderChatsTab,
  renderStoriesTab,
  renderSettingsTab,
  selectedNavTab,
  storiesEnabled,
  unreadCallsCount,
  unreadConversationsStats,
  unreadCountBadgeType,
  unreadStoriesCount,
}: NavTabsProps): JSX.Element {
  function handleSelectionChange(key: Key) {
    const tab = key as NavTab;
    if (tab === NavTab.Settings) {
      onChangeLocation({
        tab: NavTab.Settings,
        details: {
          page: SettingsPage.Profile,
          state: ProfileEditorPage.None,
        },
      });
    } else if (tab === NavTab.Chats) {
      onChangeLocation({
        tab: NavTab.Chats,
        details: {
          conversationId: undefined,
        },
      });
    } else {
      onChangeLocation({ tab });
    }
  }

  return (
    <Tabs
      orientation="vertical"
      className="NavTabs__Container"
      selectedKey={selectedNavTab}
      onSelectionChange={handleSelectionChange}
    >
      <nav
        data-supertab
        className={classNames('NavTabs', {
          'NavTabs--collapsed': navTabsCollapsed,
        })}
      >
        <NavTabsToggle
          i18n={i18n}
          navTabsCollapsed={navTabsCollapsed}
          onToggleNavTabsCollapse={onToggleNavTabsCollapse}
          // These are all shown elsewhere when nav tabs are shown
          hasFailedStorySends={false}
          hasPendingUpdate={false}
          otherTabsUnreadCount={0}
        />
        <TabList className="NavTabs__TabList">
          <NavTabsItem
            i18n={i18n}
            id={NavTab.Chats}
            label={i18n('icu:NavTabs__ItemLabel--Chats')}
            iconClassName="NavTabs__ItemIcon--Chats"
            navTabClassName="NavTabs__Item--Chats"
            unreadCount={getUnreadCountForBadge(
              unreadConversationsStats,
              unreadCountBadgeType
            )}
          />
          <NavTabsItem
            i18n={i18n}
            id={NavTab.Calls}
            label={i18n('icu:NavTabs__ItemLabel--Calls')}
            iconClassName="NavTabs__ItemIcon--Calls"
            navTabClassName="NavTabs__Item--Calls"
            unreadCount={unreadCallsCount}
          />
          {storiesEnabled && (
            <NavTabsItem
              i18n={i18n}
              id={NavTab.Stories}
              label={i18n('icu:NavTabs__ItemLabel--Stories')}
              iconClassName="NavTabs__ItemIcon--Stories"
              hasError={hasFailedStorySends}
              navTabClassName="NavTabs__Item--Stories"
              unreadCount={unreadStoriesCount}
            />
          )}
          <NavTabsItem
            i18n={i18n}
            id={NavTab.Settings}
            label={i18n('icu:NavTabs__ItemLabel--Settings')}
            iconClassName="NavTabs__ItemIcon--Settings"
            navTabClassName="NavTabs__Item--Settings"
            unreadCount={0}
            hasPendingUpdate={hasPendingUpdate}
          />
        </TabList>
      </nav>
      <TabPanel id={NavTab.Chats} className="NavTabs__TabPanel">
        {renderChatsTab}
      </TabPanel>
      <TabPanel id={NavTab.Calls} className="NavTabs__TabPanel">
        {renderCallsTab}
      </TabPanel>
      <TabPanel id={NavTab.Stories} className="NavTabs__TabPanel">
        {renderStoriesTab}
      </TabPanel>
      <TabPanel id={NavTab.Settings} className="NavTabs__TabPanel">
        {renderSettingsTab}
      </TabPanel>
    </Tabs>
  );
}


```

## ts/state/smart/NavTabs.preload.tsx

Redux-backed navigation adapter and unread/update state.

```tsx
// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback } from 'react';
import type { ReactNode, JSX } from 'react';
import { useSelector } from 'react-redux';
import { NavTabs } from '../../components/NavTabs.dom.tsx';
import { getIntl } from '../selectors/user.std.ts';
import { getAllConversationsUnreadStats } from '../selectors/conversations.dom.ts';
import {
  getHasAnyFailedStorySends,
  getStoriesNotificationCount,
} from '../selectors/stories.preload.ts';
import {
  getStoriesEnabled,
  getUnreadCountBadgeType,
} from '../selectors/items.dom.ts';
import { getSelectedNavTab } from '../selectors/nav.std.ts';
import { useNavActions } from '../ducks/nav.std.ts';
import { getHasPendingUpdate } from '../selectors/updates.std.ts';
import { getCallHistoryUnreadCount } from '../selectors/callHistory.std.ts';

import type { Location } from '../../types/Nav.std.ts';

export type SmartNavTabsProps = Readonly<{
  navTabsCollapsed: boolean;
  onToggleNavTabsCollapse: (navTabsCollapsed: boolean) => void;
  renderCallsTab: () => ReactNode;
  renderChatsTab: () => ReactNode;
  renderStoriesTab: () => ReactNode;
  renderSettingsTab: () => ReactNode;
}>;

export const SmartNavTabs = memo(function SmartNavTabs({
  navTabsCollapsed,
  onToggleNavTabsCollapse,
  renderCallsTab,
  renderChatsTab,
  renderStoriesTab,
  renderSettingsTab,
}: SmartNavTabsProps): JSX.Element {
  const i18n = useSelector(getIntl);
  const selectedNavTab = useSelector(getSelectedNavTab);
  const unreadCountBadgeType = useSelector(getUnreadCountBadgeType);
  const storiesEnabled = useSelector(getStoriesEnabled);
  const unreadConversationsStats = useSelector(getAllConversationsUnreadStats);
  const unreadStoriesCount = useSelector(getStoriesNotificationCount);
  const unreadCallsCount = useSelector(getCallHistoryUnreadCount);
  const hasFailedStorySends = useSelector(getHasAnyFailedStorySends);
  const hasPendingUpdate = useSelector(getHasPendingUpdate);

  const { changeLocation } = useNavActions();

  const onChangeLocation = useCallback(
    (location: Location) => {
      // For some reason react-aria will call this more often than the tab
      // actually changing.
      if (location.tab !== selectedNavTab) {
        changeLocation(location);
      }
    },
    [changeLocation, selectedNavTab]
  );

  return (
    <NavTabs
      unreadCountBadgeType={unreadCountBadgeType}
      hasFailedStorySends={hasFailedStorySends}
      hasPendingUpdate={hasPendingUpdate}
      i18n={i18n}
      navTabsCollapsed={navTabsCollapsed}
      onChangeLocation={onChangeLocation}
      onToggleNavTabsCollapse={onToggleNavTabsCollapse}
      renderCallsTab={renderCallsTab}
      renderChatsTab={renderChatsTab}
      renderStoriesTab={renderStoriesTab}
      renderSettingsTab={renderSettingsTab}
      selectedNavTab={selectedNavTab}
      storiesEnabled={storiesEnabled}
      unreadCallsCount={unreadCallsCount}
      unreadConversationsStats={unreadConversationsStats}
      unreadStoriesCount={unreadStoriesCount}
    />
  );
});


```

## ts/components/NavSidebar.dom.tsx

Resizable left sidebar shared by Chats, Calls, Stories, and Settings.

```tsx
// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ButtonHTMLAttributes, ReactNode, JSX } from 'react';
import {
  createContext,
  useCallback,
  useEffect,
  useState,
  forwardRef,
} from 'react';
import classNames from 'classnames';
import { useMove } from 'react-aria';
import { NavTabsToggle } from './NavTabs.dom.tsx';
import type { LocalizerType } from '../types/I18N.std.ts';
import {
  MAX_WIDTH,
  MIN_FULL_WIDTH,
  MIN_WIDTH,
  getWidthFromPreferredWidth,
} from '../util/leftPaneWidth.std.ts';
import { WidthBreakpoint, getNavSidebarWidthBreakpoint } from './_util.std.ts';
import type { SmartPropsType as SmartToastManagerPropsType } from '../state/smart/ToastManager.preload.tsx';
import { AxoDragRegion } from '../axo/AxoDragRegion.dom.tsx';

export const NavSidebarWidthBreakpointContext =
  createContext<WidthBreakpoint | null>(null);

type NavSidebarActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  Readonly<{
    icon: ReactNode;
    label: ReactNode;
  }>;

export const NavSidebarActionButton = forwardRef<
  HTMLButtonElement,
  NavSidebarActionButtonProps
>(function NavSidebarActionButtonInner(
  { icon, label, ...rest },
  ref
): JSX.Element {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      className="NavSidebar__ActionButton"
    >
      {icon}
      <span className="NavSidebar__ActionButtonLabel">{label}</span>
    </button>
  );
});

export type NavSidebarProps = Readonly<{
  actions?: ReactNode;
  children: ReactNode;
  i18n: LocalizerType;
  hasFailedStorySends: boolean;
  hasPendingUpdate: boolean;
  hideHeader?: boolean;
  navTabsCollapsed: boolean;
  onBack?: (() => void) | null;
  onToggleNavTabsCollapse: (navTabsCollapsed: boolean) => void;
  preferredLeftPaneWidth: number;
  requiresFullWidth: boolean;
  savePreferredLeftPaneWidth: (width: number) => void;
  title: string;
  /** Truki: replaces the <h1> title when provided. Chats tab only. */
  titleSlot?: ReactNode;
  otherTabsUnreadCount: number;
  renderToastManager: (_: SmartToastManagerPropsType) => JSX.Element;
}>;

enum DragState {
  INITIAL,
  DRAGGING,
  DRAGEND,
}

export function NavSidebar({
  actions,
  children,
  hideHeader,
  i18n,
  hasFailedStorySends,
  hasPendingUpdate,
  navTabsCollapsed,
  onBack,
  onToggleNavTabsCollapse,
  preferredLeftPaneWidth,
  requiresFullWidth,
  savePreferredLeftPaneWidth,
  title,
  titleSlot,
  otherTabsUnreadCount,
  renderToastManager,
}: NavSidebarProps): JSX.Element {
  const isRTL = i18n.getLocaleDirection() === 'rtl';
  const [dragState, setDragState] = useState(DragState.INITIAL);

  const [preferredWidth, setPreferredWidth] = useState(() => {
    return getWidthFromPreferredWidth(preferredLeftPaneWidth, {
      requiresFullWidth,
    });
  });

  const width = getWidthFromPreferredWidth(preferredWidth, {
    requiresFullWidth,
  });

  const widthBreakpoint = getNavSidebarWidthBreakpoint(width);

  const expandNarrowLeftPane = useCallback(() => {
    if (preferredWidth < MIN_FULL_WIDTH) {
      setPreferredWidth(MIN_FULL_WIDTH);
      savePreferredLeftPaneWidth(MIN_FULL_WIDTH);
    }
  }, [preferredWidth, savePreferredLeftPaneWidth]);

  // `useMove` gives us keyboard and mouse dragging support.
  const { moveProps } = useMove({
    onMoveStart() {
      setDragState(DragState.DRAGGING);
    },
    onMoveEnd() {
      setDragState(DragState.DRAGEND);
    },
    onMove(event) {
      const { shiftKey, pointerType } = event;
      const deltaX = isRTL ? -event.deltaX : event.deltaX;
      const isKeyboard = pointerType === 'keyboard';
      const increment = isKeyboard && shiftKey ? 10 : 1;
      setPreferredWidth(prevWidth => {
        // Jump minimize for keyboard users
        if (isKeyboard && prevWidth === MIN_FULL_WIDTH && deltaX < 0) {
          return MIN_WIDTH;
        }
        // Jump maximize for keyboard users
        if (isKeyboard && prevWidth === MIN_WIDTH && deltaX > 0) {
          return MIN_FULL_WIDTH;
        }
        return prevWidth + deltaX * increment;
      });
    },
  });

  useEffect(() => {
    // Save the preferred width when the drag ends. We can't do this in onMoveEnd
    // because the width is not updated yet.
    if (dragState === DragState.DRAGEND) {
      // oxlint-disable-next-line react/set-state-in-effect
      setPreferredWidth(width);
      savePreferredLeftPaneWidth(width);
      setDragState(DragState.INITIAL);
    }
  }, [
    dragState,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
    preferredLeftPaneWidth,
    preferredWidth,
    savePreferredLeftPaneWidth,
    width,
  ]);

  useEffect(() => {
    // This effect helps keep the pointer `col-resize` even when you drag past the handle.
    const className = 'NavSidebar__document--draggingHandle';
    if (dragState === DragState.DRAGGING) {
      document.body.classList.add(className);
      return () => {
        document.body.classList.remove(className);
      };
    }
    return undefined;
  }, [dragState]);

  return (
    <NavSidebarWidthBreakpointContext.Provider value={widthBreakpoint}>
      <div
        role="navigation"
        className={classNames('NavSidebar', {
          'NavSidebar--narrow': widthBreakpoint === WidthBreakpoint.Narrow,
        })}
        style={{ width }}
      >
        {!hideHeader && (
          <AxoDragRegion.Root>
            <div className="NavSidebar__Header">
              {onBack == null && navTabsCollapsed && (
                <NavTabsToggle
                  i18n={i18n}
                  navTabsCollapsed={navTabsCollapsed}
                  onToggleNavTabsCollapse={onToggleNavTabsCollapse}
                  hasFailedStorySends={hasFailedStorySends}
                  hasPendingUpdate={hasPendingUpdate}
                  otherTabsUnreadCount={otherTabsUnreadCount}
                />
              )}
              <div
                className={classNames('NavSidebar__HeaderContent', {
                  'NavSidebar__HeaderContent--navTabsCollapsed':
                    navTabsCollapsed,
                  'NavSidebar__HeaderContent--withBackButton': onBack != null,
                })}
              >
                {onBack != null && (
                  <button
                    type="button"
                    role="link"
                    onClick={onBack}
                    className="NavSidebar__BackButton"
                  >
                    <span className="NavSidebar__BackButtonLabel">
                      {i18n('icu:NavSidebar__BackButtonLabel')}
                    </span>
                  </button>
                )}
                {titleSlot ?? (
                  <h1
                    className={classNames('NavSidebar__HeaderTitle', {
                      'NavSidebar__HeaderTitle--withBackButton': onBack != null,
                    })}
                    aria-live="assertive"
                  >
                    {title}
                  </h1>
                )}
                {actions && (
                  <div className="NavSidebar__HeaderActions">{actions}</div>
                )}
              </div>
            </div>
          </AxoDragRegion.Root>
        )}

        <div className="NavSidebar__Content">{children}</div>

        <div
          className={classNames('NavSidebar__DragHandle', {
            'NavSidebar__DragHandle--dragging':
              dragState === DragState.DRAGGING,
          })}
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={preferredLeftPaneWidth}
          aria-valuenow={MAX_WIDTH}
          tabIndex={0}
          {...moveProps}
        />

        {renderToastManager({
          containerWidthBreakpoint: widthBreakpoint,
          expandNarrowLeftPane,
        })}
      </div>
    </NavSidebarWidthBreakpointContext.Provider>
  );
}

export function NavSidebarSearchHeader({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return <div className="NavSidebarSearchHeader">{children}</div>;
}

export function NavSidebarEmpty({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <div className="NavSidebarEmpty">
      <div className="NavSidebarEmpty__inner">
        <h3 className="NavSidebarEmpty__title">{title}</h3>
        <p className="NavSidebarEmpty__subtitle">{subtitle}</p>
      </div>
    </div>
  );
}


```




