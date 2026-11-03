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
  show: (
    chatId: string,
    title: string,
    body: string,
    onClick: () => void
  ) => void;
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
      deps.show(e.chatId, e.senderName, e.preview, onClick);
      return;
    case 'name':
      deps.show(e.chatId, e.senderName, genericText(), onClick);
      return;
    case 'count':
      deps.show(e.chatId, GENERIC_TITLE, genericText(), onClick);
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
  chatId: string,
  title: string,
  body: string,
  onClick: () => void
) => void;

// The part of the DOM Notification the show path uses; tests inject a fake
// with the same shape.
export type TrukiBridgeNotification = {
  close(): void;
  onclick: Notification['onclick'];
  onclose: Notification['onclose'];
};

export type TrukiBridgeNotificationCtor = new (
  title: string,
  options: Readonly<{ body: string; tag: string; silent: boolean }>
) => TrukiBridgeNotification;

// One live notification per chat. The map keeps the reference (Electron's
// renderer can garbage-collect an unreferenced Notification, after which its
// onclick stops firing) and lets a new message replace the previous
// notification instead of stacking another one.
const notificationsByChat = new Map<string, TrukiBridgeNotification>();

function forgetShown(
  chatId: string,
  notification: TrukiBridgeNotification
): void {
  if (notificationsByChat.get(chatId) === notification) {
    notificationsByChat.delete(chatId);
  }
}

let notificationCtor: TrukiBridgeNotificationCtor = window.Notification;

export function setTrukiBridgeNotificationCtorForTesting(
  ctor: TrukiBridgeNotificationCtor | undefined
): void {
  for (const notification of notificationsByChat.values()) {
    notification.close();
  }
  notificationsByChat.clear();
  notificationCtor = ctor ?? window.Notification;
}

export function getTrukiBridgeShownNotificationsForTesting(): ReadonlyMap<
  string,
  TrukiBridgeNotification
> {
  return notificationsByChat;
}

// Brings the app to the front as Signal's own notification click does:
// showWindow restores a hidden or minimised window, which focus() cannot do
// on Windows. focus() remains for a window without the IPC bridge.
function raiseWindow(): void {
  const ipc = (window as { IPC?: { showWindow?: () => void } }).IPC;
  if (typeof ipc?.showWindow === 'function') {
    ipc.showWindow();
  } else {
    window.focus();
  }
}

function showDesktopNotification(
  chatId: string,
  title: string,
  body: string,
  onClick: () => void
): void {
  const existing = notificationsByChat.get(chatId);
  if (existing) {
    notificationsByChat.delete(chatId);
    existing.close();
  }
  const notification = new notificationCtor(title, {
    body,
    tag: chatId,
    silent: false,
  });
  notification.onclick = () => {
    raiseWindow();
    onClick();
    forgetShown(chatId, notification);
  };
  notification.onclose = () => {
    forgetShown(chatId, notification);
  };
  notificationsByChat.set(chatId, notification);
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
    show: (chatId, title, body, onClick) =>
      showNotification(chatId, title, body, onClick),
    selectChat: chatId => {
      trukiSelectBridgedChat(chatId, {
        showConversation: duck.showConversation,
        selectBridgedChat: duck.selectBridgedChat,
      });
    },
  });
}
