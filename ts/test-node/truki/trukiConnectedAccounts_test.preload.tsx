// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import type { JSX } from 'react';
import type { LanguageTag } from '@signalapp/types';

import { AxoProvider } from '../../axo/AxoProvider.dom.tsx';
import type { AxoIntl } from '../../axo/_internal/AxoIntl.dom.tsx';
import { Preferences } from '../../components/Preferences.dom.tsx';
import type { PropsType as PreferencesPropsType } from '../../components/Preferences.dom.tsx';
import { TrukiConnectedAccounts } from '../../components/truki/TrukiConnectedAccounts.dom.tsx';
import type { TrukiConnectedAccountsProps } from '../../components/truki/TrukiConnectedAccounts.dom.tsx';
import {
  actions,
  getEmptyState,
  reducer,
  setTrukiBridgeClientForTesting,
} from '../../state/ducks/trukiBridge.preload.ts';
import type {
  TrukiBridgeAction,
  TrukiBridgeClient,
  TrukiBridgeStateType,
} from '../../state/ducks/trukiBridge.preload.ts';
import type { StateType } from '../../state/reducer.preload.ts';
import { renderTrukiConnectedAccounts } from '../../state/smart/TrukiConnectedAccounts.preload.tsx';
import { SettingsPage } from '../../types/Nav.std.ts';
import { ThemeType } from '../../types/Util.std.ts';
import { setupI18n } from '../../util/setupI18n.dom.tsx';
import {
  getTrukiAccountStatusKind,
  isTrukiAccountDisconnected,
} from '../../util/trukiAccountState.std.ts';
import {
  getTrukiLoginView,
  trukiNeedsBanRiskDialog,
  trukiWithBanRiskAccepted,
} from '../../util/trukiLoginFlow.std.ts';
import type { TrukiLoginView } from '../../util/trukiLoginFlow.std.ts';
import enMessages from '../../../_locales/en/messages.json' with { type: 'json' };
import type {
  TrukiBridgeEvent,
  TrukiBridgeIpcResult,
  TrukiCookieLoginParams,
  TrukiSupervisorStateName,
} from '../../../app/truki/trukiBridgeProtocol.std.ts';

const i18n = setupI18n('en', enMessages);

// Text as renderToStaticMarkup escapes it.
function html(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;');
}

const AXO_MESSAGES: AxoIntl.Messages = {
  'AxoAlertDialog.Cancel': 'Cancel',
  'AxoButton.Pending': 'Pending',
  'AxoDialog.Back': 'Back',
  'AxoDialog.Close': 'Close',
  'AxoTextField.Clear': 'Clear',
  'AxoPasswordField.Reveal': 'Show Password',
  'AxoBadge.MaxOverflow': (max: number) => `${max}+`,
  'AxoContactName.InSystemContactsLabel': 'In contacts',
};

function withAxo(node: JSX.Element): string {
  return renderToStaticMarkup(
    <AxoProvider
      resolvedAppLocale={{
        tag: 'en' as AxoIntl.AppLocaleTag,
        direction: 'ltr',
      }}
      systemPreferredLanguages={new Set(['en' as LanguageTag])}
      messages={AXO_MESSAGES}
    >
      {node}
    </AxoProvider>
  );
}

// A fake bridge answering from a table; unknown methods answer {}.
function byMethod(
  table: Readonly<Record<string, unknown>>
): (method: string, params: unknown) => unknown {
  return method => (method in table ? table[method] : {});
}

function ev(method: string, params: unknown): TrukiBridgeEvent {
  return { method: method as `event.${string}`, params };
}

function qrStep(data: string, stepId = 'qr') {
  return {
    type: 'display_and_wait',
    step_id: stepId,
    instructions: 'Scan the QR code',
    display_and_wait: { type: 'qr', data },
  };
}

const PHONE_STEP = {
  type: 'user_input',
  step_id: 'phone',
  instructions: 'Enter your phone number',
  user_input: {
    fields: [{ type: 'phone_number', id: 'phone_number', name: 'Phone' }],
  },
};

const CODE_STEP = {
  type: 'display_and_wait',
  step_id: 'code',
  instructions: 'Enter this code on your phone',
  display_and_wait: { type: 'code', data: 'ABCD-1234' },
};

const COOKIES_STEP = {
  type: 'cookies',
  step_id: 'cookies',
  instructions: 'Log in in the window',
  cookies: { url: 'https://www.messenger.com/', fields: [] },
};

const COMPLETE_STEP = {
  type: 'complete',
  step_id: 'done',
  instructions: '',
  complete: { user_login_id: 'l1' },
};

describe('truki connected accounts', () => {
  type Call = { method: string; params: unknown };
  let calls: Array<Call>;
  let respond: (method: string, params: unknown) => unknown;
  let cookieResult: TrukiBridgeIpcResult<
    { cancelled: true } | { step: unknown; seq: number }
  >;

  function makeStore(initial?: Partial<TrukiBridgeStateType>) {
    let slice: TrukiBridgeStateType = { ...getEmptyState(), ...initial };
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

  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await new Promise(resolve => {
        setImmediate(resolve);
      });
    }
  }

  function view(
    store: ReturnType<typeof makeStore>,
    network: string
  ): TrukiLoginView | undefined {
    const state = store.state();
    return getTrukiLoginView(
      state.loginAttempts?.[network],
      state.loginProcesses
    );
  }

  function running(store: ReturnType<typeof makeStore>): void {
    store.dispatch(
      actions.trukiBridgeEventReceived(
        ev('event.supervisorState', { state: 'running' })
      )
    );
  }

  beforeEach(() => {
    calls = [];
    cookieResult = { ok: true, value: { cancelled: true } };
    respond = (method, params) => {
      switch (method) {
        case 'login.flows':
          return (params as { network: string }).network === 'instagram'
            ? [{ id: 'instagram', name: 'Instagram', description: '' }]
            : [
                { id: 'qr', name: 'QR code', description: 'Scan' },
                { id: 'phone', name: 'Pairing code', description: 'Type' },
              ];
        case 'login.start':
          return (params as { flowId: string }).flowId === 'phone'
            ? { processId: 'p1', step: PHONE_STEP, seq: 1 }
            : { processId: 'p1', step: qrStep('qr-1'), seq: 1 };
        case 'networks.list':
        case 'accounts.list':
          return [];
        default:
          return {};
      }
    };
    const client: TrukiBridgeClient = {
      request: async <T,>(method: string, params?: unknown) => {
        calls.push({ method, params });
        const value = respond(method, params);
        if (
          typeof value === 'object' &&
          value != null &&
          'ok' in value &&
          value.ok === false
        ) {
          return value as TrukiBridgeIpcResult<T>;
        }
        return { ok: true, value: value as T };
      },
      getState: async (): Promise<
        TrukiBridgeIpcResult<TrukiSupervisorStateName>
      > => ({ ok: true, value: 'running' }),
      restart: async (): Promise<TrukiBridgeIpcResult<void>> => {
        calls.push({ method: 'restart', params: undefined });
        return { ok: true, value: undefined };
      },
      onEvent: () => () => undefined,
      setEnabledNetworks: async (ids: ReadonlyArray<string>) => {
        calls.push({ method: 'setEnabledNetworks', params: ids });
        return { ok: true, value: undefined };
      },
      cookieLogin: async (params: TrukiCookieLoginParams) => {
        calls.push({ method: 'cookieLogin', params });
        return cookieResult;
      },
    };
    setTrukiBridgeClientForTesting(client);
  });

  afterEach(() => {
    setTrukiBridgeClientForTesting(undefined);
  });

  describe('login flow state machine', () => {
    it('enableNetwork keeps the other enabled networks and loads the flows', async () => {
      const store = makeStore({
        bridgeState: 'running',
        networks: [
          { id: 'whatsapp', name: 'WhatsApp', enabled: false },
          { id: 'meta', name: 'Messenger', enabled: true },
        ],
      });
      respond = byMethod({
        'networks.list': [
          { id: 'whatsapp', name: 'WhatsApp', enabled: false },
          { id: 'meta', name: 'Messenger', enabled: true },
        ],
        'login.flows': [
          { id: 'qr', name: 'QR', description: '' },
          { id: 'phone', name: 'Phone', description: '' },
        ],
      });
      store.dispatch(actions.enableNetwork('whatsapp'));
      await flush();
      const set = calls.find(c => c.method === 'setEnabledNetworks');
      assert.deepEqual(set?.params, ['meta', 'whatsapp']);
      const v = view(store, 'whatsapp');
      assert.strictEqual(v?.kind, 'choose-flow');
      assert.deepEqual(
        v?.kind === 'choose-flow' ? v.flows.map(f => f.id) : [],
        ['qr', 'phone']
      );
    });

    it('waits for the bridge to start before asking for flows', async () => {
      const store = makeStore({ bridgeState: 'stopped' });
      store.dispatch(actions.enableNetwork('whatsapp'));
      await flush();
      assert.deepEqual(
        calls.find(c => c.method === 'setEnabledNetworks')?.params,
        ['whatsapp']
      );
      assert.notExists(calls.find(c => c.method === 'login.flows'));
      assert.strictEqual(view(store, 'whatsapp')?.kind, 'waiting');

      running(store);
      await flush();
      assert.strictEqual(view(store, 'whatsapp')?.kind, 'choose-flow');
    });

    it('a single flow starts at once', async () => {
      const store = makeStore({ bridgeState: 'running' });
      respond = byMethod({
        'login.flows': [
          { id: 'instagram', name: 'Instagram', description: '' },
        ],
        'login.start': { processId: 'p9', step: COOKIES_STEP, seq: 1 },
        'networks.list': [],
        'accounts.list': [],
      });
      store.dispatch(actions.enableNetwork('instagram'));
      await flush();
      assert.deepEqual(calls.find(c => c.method === 'login.start')?.params, {
        network: 'instagram',
        flowId: 'instagram',
      });
      assert.strictEqual(view(store, 'instagram')?.kind, 'cookies');
    });

    it('a QR refresh replaces the QR; an older step does not', async () => {
      const store = makeStore({ bridgeState: 'running' });
      store.dispatch(actions.startLogin('whatsapp', 'qr'));
      await flush();
      assert.deepInclude(view(store, 'whatsapp'), { kind: 'qr', data: 'qr-1' });

      store.dispatch(
        actions.trukiBridgeEventReceived(
          ev('event.login.step', {
            processId: 'p1',
            step: qrStep('qr-2'),
            seq: 2,
          })
        )
      );
      assert.deepInclude(view(store, 'whatsapp'), { kind: 'qr', data: 'qr-2' });

      store.dispatch(
        actions.trukiBridgeEventReceived(
          ev('event.login.step', {
            processId: 'p1',
            step: qrStep('stale'),
            seq: 1,
          })
        )
      );
      assert.deepInclude(view(store, 'whatsapp'), { kind: 'qr', data: 'qr-2' });
    });

    it('a step that arrives before the login.start result is kept', async () => {
      const store = makeStore({ bridgeState: 'running' });
      respond = method => {
        if (method === 'login.start') {
          store.dispatch(
            actions.trukiBridgeEventReceived(
              ev('event.login.step', {
                processId: 'p1',
                step: qrStep('early-2'),
                seq: 2,
              })
            )
          );
          return { processId: 'p1', step: qrStep('qr-1'), seq: 1 };
        }
        return [];
      };
      store.dispatch(actions.startLogin('whatsapp', 'qr'));
      await flush();
      assert.deepInclude(view(store, 'whatsapp'), {
        kind: 'qr',
        data: 'early-2',
      });
    });

    it('complete returns to the list and reloads the accounts', async () => {
      const store = makeStore({ bridgeState: 'running' });
      store.dispatch(actions.startLogin('whatsapp', 'qr'));
      await flush();
      calls = [];
      store.dispatch(
        actions.trukiBridgeEventReceived(
          ev('event.login.step', {
            processId: 'p1',
            step: COMPLETE_STEP,
            seq: 2,
          })
        )
      );
      await flush();
      assert.isUndefined(view(store, 'whatsapp'));
      assert.notProperty(store.state().loginProcesses, 'p1');
      assert.exists(calls.find(c => c.method === 'accounts.list'));
    });

    it('an error shows Try again, which starts the same flow again', async () => {
      const store = makeStore({ bridgeState: 'running' });
      store.dispatch(actions.startLogin('whatsapp', 'qr'));
      await flush();
      store.dispatch(
        actions.trukiBridgeEventReceived(
          ev('event.login.step', {
            processId: 'p1',
            error: { code: 'LOGIN_EXPIRED', message: 'timed out' },
          })
        )
      );
      assert.deepEqual(view(store, 'whatsapp'), {
        kind: 'error',
        error: { code: 'LOGIN_EXPIRED', message: 'timed out' },
      });

      calls = [];
      respond = method =>
        method === 'login.start'
          ? { processId: 'p2', step: qrStep('qr-new'), seq: 1 }
          : [];
      store.dispatch(actions.retryLogin('whatsapp'));
      await flush();
      assert.deepEqual(calls.find(c => c.method === 'login.start')?.params, {
        network: 'whatsapp',
        flowId: 'qr',
      });
      assert.deepInclude(view(store, 'whatsapp'), {
        kind: 'qr',
        data: 'qr-new',
      });
    });

    it('a refused login.start is an error with Try again', async () => {
      const store = makeStore({ bridgeState: 'running' });
      respond = () => ({
        ok: false,
        code: 'BRIDGE_ERROR',
        bridgeCode: 'NOT_FOUND',
        message: 'unknown network',
      });
      store.dispatch(actions.startLogin('whatsapp', 'qr'));
      await flush();
      assert.deepEqual(view(store, 'whatsapp'), {
        kind: 'error',
        error: { code: 'NOT_FOUND', message: 'unknown network' },
      });
    });

    it('a pairing code: the phone form submits, then the code is shown', async () => {
      const store = makeStore({ bridgeState: 'running' });
      store.dispatch(actions.startLogin('whatsapp', 'phone'));
      await flush();
      const form = view(store, 'whatsapp');
      assert.strictEqual(form?.kind, 'input');
      assert.deepEqual(
        form?.kind === 'input' ? form.fields.map(f => f.id) : [],
        ['phone_number']
      );

      respond = method =>
        method === 'login.submit' ? { step: CODE_STEP, seq: 2 } : [];
      store.dispatch(
        actions.submitLoginInput('whatsapp', { phone_number: '+3725551234' })
      );
      await flush();
      assert.deepEqual(calls.find(c => c.method === 'login.submit')?.params, {
        processId: 'p1',
        stepId: 'phone',
        input: { phone_number: '+3725551234' },
      });
      assert.deepInclude(view(store, 'whatsapp'), {
        kind: 'code',
        code: 'ABCD-1234',
      });
    });

    it('a cookies step opens the login window; cancelled keeps the step, a result applies', async () => {
      const store = makeStore({ bridgeState: 'running' });
      respond = method =>
        method === 'login.start'
          ? { processId: 'p3', step: COOKIES_STEP, seq: 1 }
          : [];
      store.dispatch(actions.startLogin('meta', 'messenger'));
      await flush();
      store.dispatch(actions.startCookieLogin('meta'));
      await flush();
      assert.deepEqual(calls.find(c => c.method === 'cookieLogin')?.params, {
        processId: 'p3',
        stepId: 'cookies',
      });
      assert.strictEqual(view(store, 'meta')?.kind, 'cookies');
      assert.isFalse(store.state().loginAttempts?.meta?.busy ?? false);

      cookieResult = { ok: true, value: { step: COMPLETE_STEP, seq: 2 } };
      store.dispatch(actions.startCookieLogin('meta'));
      await flush();
      assert.isUndefined(view(store, 'meta'));
    });

    it('cancelLogin cancels the process and returns to the list', async () => {
      const store = makeStore({ bridgeState: 'running' });
      store.dispatch(actions.startLogin('whatsapp', 'qr'));
      await flush();
      store.dispatch(actions.cancelLogin('whatsapp'));
      await flush();
      assert.deepEqual(calls.find(c => c.method === 'login.cancel')?.params, {
        processId: 'p1',
      });
      assert.isUndefined(view(store, 'whatsapp'));
      assert.notProperty(store.state().loginProcesses, 'p1');
    });

    it('logout logs the account out and reloads the accounts', async () => {
      const store = makeStore({
        bridgeState: 'running',
        accounts: [
          {
            loginId: 'l1',
            network: 'whatsapp',
            remoteName: 'Me',
            state: 'CONNECTED',
          },
        ],
      });
      store.dispatch(actions.logout('whatsapp', 'l1'));
      await flush();
      assert.deepEqual(
        calls.find(c => c.method === 'accounts.logout')?.params,
        { loginId: 'l1', network: 'whatsapp' }
      );
      assert.exists(calls.find(c => c.method === 'accounts.list'));
      assert.lengthOf(store.state().accounts, 0);
    });
  });

  describe('ban-risk dialog', () => {
    it('is shown only once per network', () => {
      let accepted: ReadonlyArray<string> | undefined;
      assert.isTrue(trukiNeedsBanRiskDialog(accepted, 'whatsapp'));
      accepted = trukiWithBanRiskAccepted(accepted, 'whatsapp');
      assert.isFalse(trukiNeedsBanRiskDialog(accepted, 'whatsapp'));
      assert.isTrue(trukiNeedsBanRiskDialog(accepted, 'meta'));
      accepted = trukiWithBanRiskAccepted(accepted, 'whatsapp');
      assert.deepEqual(accepted, ['whatsapp']);
    });
  });

  describe('account state', () => {
    it('maps bridgev2 states to the shown status', () => {
      assert.strictEqual(getTrukiAccountStatusKind('CONNECTED'), 'connected');
      assert.strictEqual(getTrukiAccountStatusKind('BACKFILLING'), 'connected');
      assert.strictEqual(getTrukiAccountStatusKind('CONNECTING'), 'connecting');
      assert.strictEqual(getTrukiAccountStatusKind('UNKNOWN'), 'connecting');
      assert.strictEqual(getTrukiAccountStatusKind('LOGGED_OUT'), 'logged-out');
      assert.strictEqual(
        getTrukiAccountStatusKind('BAD_CREDENTIALS'),
        'logged-out'
      );
      assert.strictEqual(
        getTrukiAccountStatusKind('TRANSIENT_DISCONNECT'),
        'error'
      );
      assert.strictEqual(getTrukiAccountStatusKind('UNKNOWN_ERROR'), 'error');
      for (const s of [
        'TRANSIENT_DISCONNECT',
        'BAD_CREDENTIALS',
        'UNKNOWN_ERROR',
        'LOGGED_OUT',
      ]) {
        assert.isTrue(isTrukiAccountDisconnected(s), s);
      }
      assert.isFalse(isTrukiAccountDisconnected('CONNECTED'));
      assert.isFalse(isTrukiAccountDisconnected('CONNECTING'));
    });
  });

  describe('page', () => {
    function noop() {
      return undefined;
    }

    function renderPage(
      overrides: Partial<TrukiConnectedAccountsProps> = {}
    ): string {
      const props: TrukiConnectedAccountsProps = {
        i18n,
        bridgeState: 'running',
        networks: [
          { id: 'whatsapp', name: 'WhatsApp' },
          { id: 'meta', name: 'Facebook Messenger' },
        ],
        accounts: [
          {
            loginId: 'l1',
            network: 'whatsapp',
            remoteName: '+372 555 1234',
            state: 'TRANSIENT_DISCONNECT',
            reason: 'wa-conn-lost: connection lost',
          },
        ],
        loginViews: {},
        busyNetworks: [],
        banRiskAccepted: [],
        onAcceptBanRisk: noop,
        onConnect: noop,
        onLogout: noop,
        onChooseFlow: noop,
        onSubmitInput: noop,
        onOpenCookieLogin: noop,
        onCancelLogin: noop,
        onRetryLogin: noop,
        onRestartBridge: noop,
        ...overrides,
      };
      return withAxo(<TrukiConnectedAccounts {...props} />);
    }

    it('lists networks with account status, reason, Connect and Log out', () => {
      const markup = renderPage();
      assert.include(markup, 'WhatsApp');
      assert.include(markup, 'Facebook Messenger');
      assert.include(markup, '+372 555 1234');
      assert.include(markup, 'wa-conn-lost: connection lost');
      assert.include(markup, i18n('icu:TrukiConnectedAccounts__Status--error'));
      assert.include(markup, i18n('icu:TrukiConnectedAccounts__Connect'));
      assert.include(markup, i18n('icu:TrukiConnectedAccounts__LogOut'));
    });

    it('renders a QR step with Signal’s QrCode and a Cancel button', () => {
      const markup = renderPage({
        loginViews: {
          whatsapp: { kind: 'qr', data: 'qr-1', instructions: 'Scan it' },
        },
      });
      assert.match(
        markup,
        new RegExp(
          `<img alt="${i18n('icu:TrukiConnectedAccounts__QrAlt', {
            network: 'WhatsApp',
          })}"[^>]*src="data:image/svg\\+xml`
        )
      );
      assert.include(markup, 'Scan it');
      assert.include(markup, i18n('icu:cancel'));
    });

    it('shows a pairing code large, an input form, and errors with Try again', () => {
      assert.include(
        renderPage({
          loginViews: {
            whatsapp: { kind: 'code', code: 'ABCD-1234', instructions: '' },
          },
        }),
        'ABCD-1234'
      );
      const form = renderPage({
        loginViews: {
          whatsapp: {
            kind: 'input',
            stepId: 'phone',
            instructions: '',
            fields: [
              {
                id: 'phone_number',
                type: 'phone_number',
                name: 'Phone number',
                description: '',
                defaultValue: '',
                optional: false,
              },
            ],
          },
        },
      });
      assert.match(form, /<input[^>]*placeholder="Phone number"/);
      assert.include(form, 'Phone number');

      const expired = renderPage({
        loginViews: {
          whatsapp: {
            kind: 'error',
            error: { code: 'LOGIN_EXPIRED', message: 'timeout' },
          },
        },
      });
      assert.include(expired, i18n('icu:TrukiConnectedAccounts__LoginExpired'));
      assert.include(expired, i18n('icu:TrukiConnectedAccounts__TryAgain'));

      const failed = renderPage({
        loginViews: {
          whatsapp: {
            kind: 'error',
            error: { code: 'LOGIN_FAILED', message: 'Wrong password' },
          },
        },
      });
      assert.include(failed, 'Wrong password');
    });

    it('a stopped bridge shows Restart; no secure storage shows its text', () => {
      const stopped = renderPage({ bridgeState: 'gave-up' });
      assert.include(
        stopped,
        i18n('icu:TrukiConnectedAccounts__BridgeStopped')
      );
      assert.include(stopped, i18n('icu:TrukiConnectedAccounts__Restart'));

      const unavailable = renderPage({ bridgeState: 'unavailable' });
      assert.include(
        unavailable,
        html(i18n('icu:TrukiConnectedAccounts__SecureStorageUnavailable'))
      );
      assert.notInclude(
        unavailable,
        i18n('icu:TrukiConnectedAccounts__Restart')
      );
      assert.notInclude(
        renderPage(),
        i18n('icu:TrukiConnectedAccounts__BridgeStopped')
      );
    });
  });

  describe('Preferences', () => {
    // Only what the nav and the Connected accounts branch read; every other
    // prop is a no-op function.
    function preferencesProps(
      overrides: Partial<PreferencesPropsType>
    ): PreferencesPropsType {
      const base: Partial<PreferencesPropsType> = {
        i18n,
        theme: ThemeType.light,
        me: {
          id: 'me',
          title: 'Me',
          color: undefined,
          type: 'direct',
          acceptedMessageRequest: true,
          badges: [],
          isMe: true,
          sharedGroupNames: [],
        } as unknown as PreferencesPropsType['me'],
        settingsLocation: { page: SettingsPage.General },
        availableCameras: [],
        availableLocales: [],
        availableMicrophones: [],
        availableSpeakers: [],
        blockedContacts: [],
        blockedGroups: [],
        customColors: {},
        donationReceipts: [],
        preferredSystemLocales: [],
        renderToastManager: () => <div />,
        renderUpdateDialog: () => <div />,
        ...overrides,
      };
      return new Proxy(base, {
        get(target, key) {
          if (key in target) {
            return target[key as keyof typeof target];
          }
          return noopFn;
        },
      }) as PreferencesPropsType;
    }
    function noopFn() {
      return undefined;
    }

    function storeWith(state: Partial<TrukiBridgeStateType>) {
      const root = {
        trukiBridge: { ...getEmptyState(), ...state },
        items: { trukiBridgeBanRiskAccepted: ['whatsapp'] },
        user: { i18n, theme: ThemeType.light },
      };
      return createStore(() => root);
    }

    let savedGetLocaleDisplayNames: unknown;
    beforeEach(() => {
      const context = window.SignalContext as unknown as Record<
        string,
        unknown
      >;
      savedGetLocaleDisplayNames = context.getLocaleDisplayNames;
      context.getLocaleDisplayNames = () => ({ en: { en: 'English' } });
    });
    afterEach(() => {
      (
        window.SignalContext as unknown as Record<string, unknown>
      ).getLocaleDisplayNames = savedGetLocaleDisplayNames;
    });

    function renderPreferences(overrides: Partial<PreferencesPropsType>) {
      return renderToStaticMarkup(
        <Provider store={storeWith({ bridgeState: 'running' })}>
          <AxoProvider
            resolvedAppLocale={{
              tag: 'en' as AxoIntl.AppLocaleTag,
              direction: 'ltr',
            }}
            systemPreferredLanguages={new Set(['en' as LanguageTag])}
            messages={AXO_MESSAGES}
          >
            <Preferences {...preferencesProps(overrides)} />
          </AxoProvider>
        </Provider>
      );
    }

    const TITLE = i18n('icu:TrukiConnectedAccounts__Title');

    it('renders the Connected accounts page when the location is set', () => {
      const markup = renderPreferences({
        settingsLocation: { page: SettingsPage.TrukiConnectedAccounts },
        renderTrukiConnectedAccounts,
      });
      assert.include(markup, 'data-testid="TrukiConnectedAccounts"');
      assert.include(markup, 'WhatsApp');
      // The nav item is shown and current.
      assert.match(
        markup,
        new RegExp(`aria-current="page"[^>]*>(?:(?!</button>).)*${TITLE}`)
      );
    });

    it('without the render prop there is no nav item and no page', () => {
      const markup = renderPreferences({
        settingsLocation: { page: SettingsPage.TrukiConnectedAccounts },
      });
      assert.notInclude(markup, 'data-testid="TrukiConnectedAccounts"');
      assert.notInclude(markup, TITLE);
    });

    it('other pages show the nav item but not the page', () => {
      const markup = renderPreferences({ renderTrukiConnectedAccounts });
      assert.include(markup, TITLE);
      assert.notInclude(markup, 'data-testid="TrukiConnectedAccounts"');
    });
  });
});
