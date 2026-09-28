# Application route and view map

Signal Desktop does not use URL routing for its primary renderer. Redux state chooses an app view and a typed `Location` chooses the active tab and settings subpage.

## View map

- Inbox app view: `ts/components/App.dom.tsx` -> `ts/state/smart/Inbox.preload.tsx`
- Chats: `NavTab.Chats` -> `SmartChatsTab`
- Calls: `NavTab.Calls` -> `SmartCallsTab`
- Stories: `NavTab.Stories` -> `SmartStoriesTab`
- Settings: `NavTab.Settings` -> `SmartPreferences`
- Settings subpages: typed by `SettingsPage`; the left selector remains visible in the current implementation.

## Typed navigation configuration

Path: `ts/types/Nav.std.ts`

```ts
// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReadonlyDeep } from 'type-fest';
import type { ChatFolderId, ChatFolderParams } from './ChatFolder.std.ts';
import type { PanelArgsType } from './Panels.std.ts';

export type Location = ReadonlyDeep<
  | {
      tab: NavTab.Chats;
      details: ChatDetails;
    }
  | {
      tab: NavTab.Settings;
      details: SettingsLocation;
    }
  | { tab: Exclude<NavTab, NavTab.Chats | NavTab.Settings> }
>;

export type ChatDetails = ReadonlyDeep<{
  conversationId?: string;
  panels?: PanelInfo;
}>;

export type PanelInfo = {
  direction: 'push' | 'pop' | undefined;
  isAnimating: boolean;
  // When navigating deep into a panel stack, we only want to render the leaf panel
  leafPanelOnly?: boolean;
  stack: ReadonlyArray<PanelArgsType>;
  wasAnimated: boolean;
  watermark: number;
};

export type SettingsLocation = ReadonlyDeep<
  | {
      page: SettingsPage.Profile;
      state: ProfileEditorPage;
    }
  | {
      page: SettingsPage.ChatFolders;
      previousLocation: Location | null;
    }
  | {
      page: SettingsPage.EditChatFolder;
      chatFolderId: ChatFolderId | null;
      initChatFolderParams: ChatFolderParams | null;
      previousLocation: Location | null;
    }
  | {
      page: Exclude<
        SettingsPage,
        | SettingsPage.Profile
        | SettingsPage.ChatFolders
        | SettingsPage.EditChatFolder
      >;
    }
>;

export enum NavTab {
  Chats = 'Chats',
  Calls = 'Calls',
  Stories = 'Stories',
  Settings = 'Settings',
}

export enum SettingsPage {
  // Accessible through left nav
  Profile = 'Profile',
  Account = 'Account',
  General = 'General',
  Donations = 'Donations',
  Appearance = 'Appearance',
  Chats = 'Chats',
  Calls = 'Calls',
  Notifications = 'Notifications',
  Privacy = 'Privacy',
  DataUsage = 'DataUsage',
  Backups = 'Backups',
  Internal = 'Internal',

  // Sub pages
  AccountKeys = 'AccountKeys',
  Blocked = 'Blocked',
  ChatColor = 'ChatColor',
  ChatFolders = 'ChatFolders',
  DonationsDonateFlow = 'DonationsDonateFlow',
  DonationsReceiptList = 'DonationsReceiptList',
  EditChatFolder = 'EditChatFolder',
  NotificationProfilesHome = 'NotificationProfilesHome',
  NotificationProfilesCreateFlow = 'NotificationProfilesCreateFlow',
  WhileMuted = 'WhileMuted',
  PNP = 'PNP',
  BackupsDetails = 'BackupsDetails',
  LocalBackups = 'LocalBackups',
  LocalBackupsSetupFolder = 'LocalBackupsSetupFolder',
  LocalBackupsSetupKey = 'LocalBackupsSetupKey',
  LocalBackupsKeyReference = 'LocalBackupsKeyReference',
}

export enum ProfileEditorPage {
  None = 'None',
  BetterAvatar = 'BetterAvatar',
  ProfileName = 'ProfileName',
  Bio = 'Bio',
  Username = 'Username',
  UsernameLink = 'UsernameLink',
}


```

## Root smart composition

Path: `ts/state/smart/App.preload.tsx`

```tsx
// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
import { memo, type JSX } from 'react';
import { useSelector } from 'react-redux';
import { App } from '../../components/App.dom.tsx';
import OS from '../../util/os/osMain.node.ts';
import { SmartCallManager } from './CallManager.preload.tsx';
import { SmartGlobalModalContainer } from './GlobalModalContainer.preload.tsx';
import { SmartLightbox } from './Lightbox.preload.tsx';
import { SmartStoryViewer } from './StoryViewer.preload.tsx';
import {
  getIntl,
  getIsMainWindowMaximized,
  getIsMainWindowFullScreen,
  getTheme,
} from '../selectors/user.std.ts';
import { MuteUntilDialogProvider } from '../../components/MuteNotificationsMenu.dom.tsx';
import { hasSelectedStoryData as getHasSelectedStoryData } from '../selectors/stories.preload.ts';
import { useConversationsActions } from '../ducks/conversations.preload.ts';
import { useStoriesActions } from '../ducks/stories.preload.ts';
import { ErrorBoundary } from '../../components/ErrorBoundary.dom.tsx';
import { ModalContainer } from '../../components/ModalContainer.dom.tsx';
import { SmartInbox } from './Inbox.preload.tsx';
import { SmartInstallScreen } from './InstallScreen.preload.tsx';
import { getApp } from '../selectors/app.std.ts';
import { SmartFunProvider } from './FunProvider.preload.tsx';
import { SmartStandaloneRegistration } from './StandaloneRegistration.preload.tsx';

function renderInbox(): JSX.Element {
  return <SmartInbox />;
}

function renderCallManager(): JSX.Element {
  return (
    <ModalContainer className="module-calling__modal-container">
      <SmartCallManager />
    </ModalContainer>
  );
}

function renderGlobalModalContainer(): JSX.Element {
  return <SmartGlobalModalContainer />;
}

function renderInstallScreen(): JSX.Element {
  return <SmartInstallScreen />;
}

function renderLightbox(): JSX.Element {
  return <SmartLightbox />;
}

function renderStandaloneRegistration(): JSX.Element {
  return (
    <ErrorBoundary name="App/renderStandaloneRegistration">
      <SmartStandaloneRegistration />
    </ErrorBoundary>
  );
}

function renderStoryViewer(closeView: () => unknown): JSX.Element {
  return (
    <ErrorBoundary name="App/renderStoryViewer" closeView={closeView}>
      <SmartStoryViewer />
    </ErrorBoundary>
  );
}

export const SmartApp = memo(function SmartApp() {
  const i18n = useSelector(getIntl);
  const state = useSelector(getApp);
  const isMaximized = useSelector(getIsMainWindowMaximized);
  const isFullScreen = useSelector(getIsMainWindowFullScreen);
  const hasSelectedStoryData = useSelector(getHasSelectedStoryData);
  const theme = useSelector(getTheme);

  const { scrollToMessage } = useConversationsActions();
  const { viewStory } = useStoriesActions();

  const osClassName = OS.getClassName();

  return (
    <SmartFunProvider>
      <MuteUntilDialogProvider i18n={i18n}>
        <App
          state={state}
          isMaximized={isMaximized}
          isFullScreen={isFullScreen}
          osClassName={osClassName}
          renderCallManager={renderCallManager}
          renderGlobalModalContainer={renderGlobalModalContainer}
          renderInstallScreen={renderInstallScreen}
          renderLightbox={renderLightbox}
          renderStandaloneRegistration={renderStandaloneRegistration}
          hasSelectedStoryData={hasSelectedStoryData}
          renderStoryViewer={renderStoryViewer}
          renderInbox={renderInbox}
          theme={theme}
          scrollToMessage={scrollToMessage}
          viewStory={viewStory}
        />
      </MuteUntilDialogProvider>
    </SmartFunProvider>
  );
});


```



