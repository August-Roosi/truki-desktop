// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  getTrukiBridgeShownNotificationsForTesting,
  handleTrukiBridgeNotify,
  handleTrukiBridgeNotifyFromDuck,
  setTrukiBridgeNotificationCtorForTesting,
  setTrukiBridgeShowNotificationForTesting,
} from '../../services/trukiBridgeNotifications.preload.ts';
import type { TrukiBridgeNotifyDeps } from '../../services/trukiBridgeNotifications.preload.ts';
import {
  actions,
  getEmptyState,
  reducer,
} from '../../state/ducks/trukiBridge.preload.ts';
import type { TrukiBridgeAction } from '../../state/ducks/trukiBridge.preload.ts';
import type { StateType } from '../../state/reducer.preload.ts';
import type { TrukiBridgeEvent } from '../../../app/truki/trukiBridgeProtocol.std.ts';
import type { NotificationSettingType } from '../../types/StorageKeys.std.ts';

const CHAT_A = '!a:truki.local';

const NOTIFY_EVENT = {
  chatId: CHAT_A,
  senderName: 'Alice',
  preview: 'hello there',
  network: 'whatsapp',
};

type Shown = Readonly<{
  chatId: string;
  title: string;
  body: string;
  onClick: () => void;
}>;

function makeDeps(overrides: Partial<TrukiBridgeNotifyDeps> = {}): {
  deps: TrukiBridgeNotifyDeps;
  shown: Array<Shown>;
  selected: Array<string>;
} {
  const shown: Array<Shown> = [];
  const selected: Array<string> = [];
  const deps: TrukiBridgeNotifyDeps = {
    getSetting: (): NotificationSettingType => 'message',
    isChatMuted: (): boolean => false,
    isChatOpenAndFocused: (): boolean => false,
    show: (
      chatId: string,
      title: string,
      body: string,
      onClick: () => void
    ): void => {
      shown.push({ chatId, title, body, onClick });
    },
    selectChat: (chatId: string): void => {
      selected.push(chatId);
    },
    ...overrides,
  };
  return { deps, shown, selected };
}

function genericText(): string {
  return window.SignalContext.i18n('icu:TrukiBridgeNotifications__NewMessage');
}

function onlyShown(shown: Array<Shown>): Shown {
  const notification = shown[0];
  if (shown.length !== 1 || !notification) {
    throw new Error(`expected exactly one notification, got ${shown.length}`);
  }
  return notification;
}

describe('trukiBridgeNotifications', () => {
  describe('handleTrukiBridgeNotify', () => {
    it('message setting shows the sender and the preview; the click selects the chat', () => {
      const { deps, shown, selected } = makeDeps();

      handleTrukiBridgeNotify(NOTIFY_EVENT, deps);

      const notification = onlyShown(shown);
      assert.strictEqual(notification.chatId, CHAT_A);
      assert.strictEqual(notification.title, 'Alice');
      assert.strictEqual(notification.body, 'hello there');

      notification.onClick();
      assert.deepEqual(selected, [CHAT_A]);
    });

    it('name setting shows the sender with the generic text instead of the preview', () => {
      const { deps, shown, selected } = makeDeps({
        getSetting: () => 'name',
      });

      handleTrukiBridgeNotify(NOTIFY_EVENT, deps);

      const notification = onlyShown(shown);
      assert.strictEqual(notification.title, 'Alice');
      assert.strictEqual(notification.body, genericText());

      notification.onClick();
      assert.deepEqual(selected, [CHAT_A]);
    });

    it('count setting shows only generic text', () => {
      const { deps, shown, selected } = makeDeps({
        getSetting: () => 'count',
      });

      handleTrukiBridgeNotify(NOTIFY_EVENT, deps);

      const notification = onlyShown(shown);
      assert.strictEqual(notification.title, 'Truki');
      assert.strictEqual(notification.body, genericText());

      notification.onClick();
      assert.deepEqual(selected, [CHAT_A]);
    });

    it('off setting shows nothing', () => {
      const { deps, shown } = makeDeps({ getSetting: () => 'off' });

      handleTrukiBridgeNotify(NOTIFY_EVENT, deps);

      assert.lengthOf(shown, 0);
    });

    it('a muted chat shows nothing', () => {
      const { deps, shown } = makeDeps({ isChatMuted: () => true });

      handleTrukiBridgeNotify(NOTIFY_EVENT, deps);

      assert.lengthOf(shown, 0);
    });

    it('an open and focused chat shows nothing', () => {
      const { deps, shown } = makeDeps({ isChatOpenAndFocused: () => true });

      handleTrukiBridgeNotify(NOTIFY_EVENT, deps);

      assert.lengthOf(shown, 0);
    });
  });

  describe('duck wiring', () => {
    let shown: Array<Shown>;

    // A minimal thunk-capable store holding only the trukiBridge slice.
    function makeStore() {
      let slice = getEmptyState();
      const getState = () => ({ trukiBridge: slice }) as unknown as StateType;
      const dispatch = (action: unknown): unknown => {
        if (typeof action === 'function') {
          return action(dispatch, getState, undefined);
        }
        slice = reducer(slice, action as TrukiBridgeAction);
        return action;
      };
      return { dispatch, state: () => slice };
    }

    function wireChat(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        network: 'whatsapp',
        loginId: 'login1',
        name: `Chat ${id}`,
        isDm: true,
        unreadCount: 0,
        lastActivity: '2026-10-21T10:00:00Z',
        ...overrides,
      };
    }

    function ev(method: string, params: unknown): TrukiBridgeEvent {
      return { method: method as `event.${string}`, params };
    }

    function notify(overrides: Record<string, unknown> = {}) {
      return ev('event.notify', {
        network: 'whatsapp',
        chatId: CHAT_A,
        senderName: 'Alice',
        messageId: '$1',
        message: 'hello there',
        ...overrides,
      });
    }

    beforeEach(() => {
      shown = [];
      setTrukiBridgeShowNotificationForTesting(
        (chatId, title, body, onClick) => {
          shown.push({ chatId, title, body, onClick });
        }
      );
    });

    afterEach(() => {
      setTrukiBridgeShowNotificationForTesting(undefined);
    });

    it('event.notify reaches the notification with the sender and the message', () => {
      const store = makeStore();
      store.dispatch(
        actions.trukiBridgeEventReceived(ev('event.chat', wireChat(CHAT_A)))
      );
      store.dispatch(actions.trukiBridgeEventReceived(notify()));

      const notification = onlyShown(shown);
      assert.strictEqual(notification.chatId, CHAT_A);
      assert.strictEqual(notification.title, 'Alice');
      assert.strictEqual(notification.body, 'hello there');
    });

    it('event.notify without a senderName falls back to the chat name', () => {
      const store = makeStore();
      store.dispatch(
        actions.trukiBridgeEventReceived(ev('event.chat', wireChat(CHAT_A)))
      );
      store.dispatch(
        actions.trukiBridgeEventReceived(notify({ senderName: undefined }))
      );

      const notification = onlyShown(shown);
      assert.strictEqual(notification.title, `Chat ${CHAT_A}`);
    });

    it('event.notify for a muted chat shows nothing', () => {
      const store = makeStore();
      store.dispatch(
        actions.trukiBridgeEventReceived(
          ev(
            'event.chat',
            wireChat(CHAT_A, { mutedUntil: '2099-01-01T00:00:00Z' })
          )
        )
      );
      store.dispatch(actions.trukiBridgeEventReceived(notify()));

      assert.lengthOf(shown, 0);
    });

    it('event.notify without a chatId shows nothing', () => {
      const store = makeStore();
      store.dispatch(
        actions.trukiBridgeEventReceived(ev('event.chat', wireChat(CHAT_A)))
      );
      store.dispatch(
        actions.trukiBridgeEventReceived(notify({ chatId: undefined }))
      );

      assert.lengthOf(shown, 0);
    });
  });

  // The real show path: one live notification per chat, replaced per message.
  // The Notification constructor is the seam.
  describe('notification replacement', () => {
    const CHAT_B = '!b:truki.local';

    const created: Array<FakeNotification> = [];

    class FakeNotification {
      readonly title: string;
      readonly options: Readonly<{
        body: string;
        tag: string;
        silent: boolean;
      }>;
      closeCount = 0;
      onclick: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(
        title: string,
        options: Readonly<{ body: string; tag: string; silent: boolean }>
      ) {
        this.title = title;
        this.options = options;
        created.push(this);
      }

      close(): void {
        this.closeCount += 1;
        this.onclose?.();
      }
    }

    let selected: Array<string>;

    function fakeDuck() {
      return {
        getState: () => ({ trukiBridge: getEmptyState() }),
        showConversation: (): undefined => undefined,
        selectBridgedChat: (chatId: string): void => {
          selected.push(chatId);
        },
      };
    }

    function notifyChat(chatId: string): void {
      handleTrukiBridgeNotifyFromDuck(
        {
          chatId,
          senderName: 'Alice',
          preview: 'hello there',
          network: 'whatsapp',
        },
        fakeDuck()
      );
    }

    function onlyCreated(index: number): FakeNotification {
      const notification = created[index];
      if (created.length !== index + 1 || !notification) {
        throw new Error(
          `expected exactly ${index + 1} notifications, got ${created.length}`
        );
      }
      return notification;
    }

    // The harness has no focusable window; the real onclick calls
    // IPC.showWindow(), or focus() without the IPC bridge.
    const oldFocus = window.focus;
    const oldIpc = Object.getOwnPropertyDescriptor(window, 'IPC');
    let focusCount = 0;
    let showWindowCount = 0;

    function setIpc(value: unknown): void {
      Object.defineProperty(window, 'IPC', {
        value,
        configurable: true,
        writable: true,
      });
    }

    beforeEach(() => {
      focusCount = 0;
      showWindowCount = 0;
      window.focus = (): void => {
        focusCount += 1;
      };
      setIpc({
        ...(oldIpc?.value ?? {}),
        showWindow: (): void => {
          showWindowCount += 1;
        },
      });
      created.length = 0;
      selected = [];
      setTrukiBridgeNotificationCtorForTesting(FakeNotification);
    });

    afterEach(() => {
      window.focus = oldFocus;
      if (oldIpc) {
        Object.defineProperty(window, 'IPC', oldIpc);
      } else {
        delete (window as { IPC?: unknown }).IPC;
      }
      setTrukiBridgeNotificationCtorForTesting(undefined);
    });

    it('a second notify for a chat closes the first and keeps one', () => {
      notifyChat(CHAT_A);
      const first = onlyCreated(0);
      notifyChat(CHAT_A);
      const second = onlyCreated(1);

      assert.strictEqual(first.closeCount, 1);
      assert.strictEqual(second.closeCount, 0);
      assert.strictEqual(second.options.tag, CHAT_A);

      const shown = getTrukiBridgeShownNotificationsForTesting();
      assert.strictEqual(shown.size, 1);
      assert.strictEqual(shown.get(CHAT_A), second);
    });

    it('notifies for two chats keep both notifications', () => {
      notifyChat(CHAT_A);
      const first = onlyCreated(0);
      notifyChat(CHAT_B);
      const second = onlyCreated(1);

      assert.strictEqual(first.closeCount, 0);
      assert.strictEqual(second.closeCount, 0);

      const shown = getTrukiBridgeShownNotificationsForTesting();
      assert.strictEqual(shown.size, 2);
      assert.strictEqual(shown.get(CHAT_A), first);
      assert.strictEqual(shown.get(CHAT_B), second);
    });

    it('clicking the notification selects the chat and drops the map entry', () => {
      notifyChat(CHAT_A);
      const notification = onlyCreated(0);

      notification.onclick?.();

      assert.strictEqual(showWindowCount, 1);
      assert.strictEqual(focusCount, 0);
      assert.strictEqual(getTrukiBridgeShownNotificationsForTesting().size, 0);
      assert.deepEqual(selected, [CHAT_A]);
    });

    it('without the IPC bridge a click falls back to focus()', () => {
      setIpc(undefined);
      notifyChat(CHAT_A);
      onlyCreated(0).onclick?.();

      assert.strictEqual(focusCount, 1);
      assert.deepEqual(selected, [CHAT_A]);
    });

    it('closing the notification drops the map entry', () => {
      notifyChat(CHAT_A);
      const notification = onlyCreated(0);

      notification.onclose?.();

      assert.strictEqual(getTrukiBridgeShownNotificationsForTesting().size, 0);
    });
  });
});
