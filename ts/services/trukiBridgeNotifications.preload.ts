// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Desktop notifications for bridged chats, docs/truki/specs/2026-10-21-truki-inbox-design.md
// §4.2. The bridge pushes `event.notify` (truki-bridge/PROTOCOL.md); the
// trukiBridge duck maps its params and calls handleTrukiBridgeNotifyFromDuck.
// Signal's notificationService is left alone: it is built around Signal
// conversations.

import type { NotificationSettingType } from '../types/StorageKeys.std.ts';
import type { TrukiBridgeStateType } from '../state/ducks/trukiBridge.preload.ts';
import type { ShowConversationType } from '../state/ducks/conversations.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { trukiSelectBridgedChat } from '../util/trukiBridgedSelection.std.ts';

export type TrukiBridgeNotifyEvent = Readonly<{
  chatId: string;
  senderName: string;
  preview: string;
  network: string;
}>;

export type TrukiBridgeNotifyDeps = Readonly<{
  getSetting: () => NotificationSettingType;
  isChatMuted: (id: string) => boolean;
  isChatOpenAndFocused: (id: string) => boolean;
  show: (title: string, body: string, onClick: () => void) => void;
  selectChat: (id: string) => void;
}>;

// The count setting hides even the chat and sender name; the title is the app
// name, like Signal's FALLBACK_NOTIFICATION_TITLE.
const GENERIC_TITLE = 'Truki';

function genericText(): string {
  return window.SignalContext.i18n('icu:TrukiBridgeNotifications__NewMessage');
}

export function handleTrukiBridgeNotify(
  e: TrukiBridgeNotifyEvent,
  deps: TrukiBridgeNotifyDeps
): void {
  const setting = deps.getSetting();
  if (
    setting === 'off' ||
    deps.isChatMuted(e.chatId) ||
    deps.isChatOpenAndFocused(e.chatId)
  ) {
    return;
  }

  const onClick = () => deps.selectChat(e.chatId);

  switch (setting) {
    case 'message':
      deps.show(e.senderName, e.preview, onClick);
      return;
    case 'name':
      deps.show(e.senderName, genericText(), onClick);
      return;
    case 'count':
      deps.show(GENERIC_TITLE, genericText(), onClick);
      return;
    default:
      return;
  }
}

// The user's notification setting; unknown stored values fall back to
// 'message', like Signal's parseNotificationSetting.
export function getTrukiBridgeNotificationSetting(): NotificationSettingType {
  const setting = itemStorage.get('notification-setting');
  return setting === 'off' ||
    setting === 'name' ||
    setting === 'count' ||
    setting === 'message'
    ? setting
    : 'message';
}

type ShowNotificationType = (
  title: string,
  body: string,
  onClick: () => void
) => void;

function showDesktopNotification(
  title: string,
  body: string,
  onClick: () => void
): void {
  const notification = new window.Notification(title, { body, silent: false });
  notification.onclick = () => {
    window.focus();
    onClick();
  };
}

let showNotification: ShowNotificationType = showDesktopNotification;

export function setTrukiBridgeShowNotificationForTesting(
  shower: ShowNotificationType | undefined
): void {
  showNotification = shower ?? showDesktopNotification;
}

// Real-deps wiring for the duck's `event.notify` branch: Signal's
// notification-setting, the chat summary's mute, the open+focused chat, an
// HTML Notification, and a click that clears Signal's selection and selects
// the bridged chat.
export function handleTrukiBridgeNotifyFromDuck(
  e: TrukiBridgeNotifyEvent,
  duck: Readonly<{
    getState: () => Readonly<{ trukiBridge: TrukiBridgeStateType }>;
    showConversation: ShowConversationType;
    selectBridgedChat: (chatId: string) => unknown;
  }>
): void {
  handleTrukiBridgeNotify(e, {
    getSetting: getTrukiBridgeNotificationSetting,
    isChatMuted: chatId => {
      const mutedUntil = duck.getState().trukiBridge.chats[chatId]?.mutedUntil;
      return mutedUntil !== undefined && mutedUntil > Date.now();
    },
    isChatOpenAndFocused: chatId =>
      duck.getState().trukiBridge.selectedChatId === chatId &&
      document.hasFocus(),
    show: (title, body, onClick) => showNotification(title, body, onClick),
    selectChat: chatId => {
      trukiSelectBridgedChat(chatId, {
        showConversation: duck.showConversation,
        selectBridgedChat: duck.selectBridgedChat,
      });
    },
  });
}
