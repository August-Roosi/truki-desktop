// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  handleTrukiBridgeNotify,
  setTrukiBridgeShowNotificationForTesting,
} from '../../services/trukiBridgeNotifications.preload.ts';
import type { TrukiBridgeNotifyDeps } from '../../services/trukiBridgeNotifications.preload.ts';
import { actions, getEmptyState, reducer } from '../../state/ducks/trukiBridge.preload.ts';
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

type Shown = Readonly<{ title: string; body: string; onClick: () => void }>;

function makeDeps(
  overrides: Partial<TrukiBridgeNotifyDeps> = {}
): { deps: TrukiBridgeNotifyDeps; shown: Array<Shown>; selected: Array<string> } {
  const shown: Array<Shown> = [];
  const selected: Array<string> = [];
  const deps: TrukiBridgeNotifyDeps = {
    getSetting: (): NotificationSettingType => 'message',
    isChatMuted: (): boolean => false,
    isChatOpenAndFocused: (): boolean => false,
    show: (title: string, body: string, onClick: () => void): void => {
      shown.push({ title, body, onClick });
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
      setTrukiBridgeShowNotificationForTesting((title, body, onClick) => {
        shown.push({ title, body, onClick });
      });
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
});
