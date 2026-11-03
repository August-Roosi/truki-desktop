// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { action } from '@storybook/addon-actions';
import type { Meta } from '@storybook/react';

import type { TrukiConnectedAccountsProps } from './TrukiConnectedAccounts.dom.tsx';
import { TrukiConnectedAccounts } from './TrukiConnectedAccounts.dom.tsx';
import type { TrukiLoginView } from '../../util/trukiLoginFlow.std.ts';

const { i18n } = window.SignalContext;

export default {
  title: 'Components/Truki/TrukiConnectedAccounts',
} satisfies Meta<TrukiConnectedAccountsProps>;

const NETWORKS = [
  { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'meta', name: 'Facebook Messenger' },
  { id: 'instagram', name: 'Instagram' },
];

function Page(props: Partial<TrukiConnectedAccountsProps>): JSX.Element {
  return (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <TrukiConnectedAccounts
        i18n={i18n}
        bridgeState="running"
        networks={NETWORKS}
        accounts={[]}
        loginViews={{}}
        busyNetworks={[]}
        banRiskAccepted={[]}
        onAcceptBanRisk={action('onAcceptBanRisk')}
        onConnect={action('onConnect')}
        onLogout={action('onLogout')}
        onChooseFlow={action('onChooseFlow')}
        onSubmitInput={action('onSubmitInput')}
        onOpenCookieLogin={action('onOpenCookieLogin')}
        onCancelLogin={action('onCancelLogin')}
        onRetryLogin={action('onRetryLogin')}
        onRestartBridge={action('onRestartBridge')}
        {...props}
      />
    </div>
  );
}

function Login({ view }: Readonly<{ view: TrukiLoginView }>): JSX.Element {
  return <Page loginViews={{ whatsapp: view }} />;
}

export function NoAccounts(): JSX.Element {
  return <Page bridgeState="stopped" />;
}

export function Accounts(): JSX.Element {
  return (
    <Page
      banRiskAccepted={['whatsapp', 'meta']}
      accounts={[
        {
          loginId: 'l1',
          network: 'whatsapp',
          remoteName: '+372 5555 1234',
          state: 'CONNECTED',
        },
        {
          loginId: 'l2',
          network: 'meta',
          remoteName: 'Mari Maasikas',
          state: 'TRANSIENT_DISCONNECT',
          reason: 'meta-connection-lost: websocket closed',
        },
        {
          loginId: 'l3',
          network: 'instagram',
          remoteName: 'mari.m',
          state: 'BAD_CREDENTIALS',
          reason: 'ig-session-expired',
        },
      ]}
    />
  );
}

export function BridgeStopped(): JSX.Element {
  return (
    <Page
      bridgeState="gave-up"
      accounts={[
        {
          loginId: 'l1',
          network: 'whatsapp',
          remoteName: '+372 5555 1234',
          state: 'CONNECTED',
        },
      ]}
    />
  );
}

export function SecureStorageUnavailable(): JSX.Element {
  return <Page bridgeState="unavailable" />;
}

export function Waiting(): JSX.Element {
  return <Login view={{ kind: 'waiting', instructions: '' }} />;
}

export function ChooseFlow(): JSX.Element {
  return (
    <Login
      view={{
        kind: 'choose-flow',
        flows: [
          { id: 'qr', name: 'QR code', description: 'Scan with your phone' },
          {
            id: 'phone',
            name: 'Pairing code',
            description: 'Type a code on your phone',
          },
        ],
      }}
    />
  );
}

export function QrCode(): JSX.Element {
  return (
    <Login
      view={{
        kind: 'qr',
        data: '2@abcdefghijklmnopqrstuvwxyz0123456789,ABCDEFGHIJ,KLMNOPQRST',
        instructions: '',
      }}
    />
  );
}

export function PhoneNumber(): JSX.Element {
  return (
    <Login
      view={{
        kind: 'input',
        stepId: 'phone',
        instructions: 'Enter your phone number in international format.',
        fields: [
          {
            id: 'phone_number',
            type: 'phone_number',
            name: 'Phone number',
            description: '+372 5555 1234',
            defaultValue: '',
            optional: false,
          },
        ],
      }}
    />
  );
}

export function PairingCode(): JSX.Element {
  return <Login view={{ kind: 'code', code: 'ABCD-EFGH', instructions: '' }} />;
}

export function Cookies(): JSX.Element {
  return (
    <Page
      loginViews={{
        meta: { kind: 'cookies', stepId: 'cookies', instructions: '' },
      }}
    />
  );
}

export function Expired(): JSX.Element {
  return (
    <Login
      view={{
        kind: 'error',
        error: { code: 'LOGIN_EXPIRED', message: 'QR code expired' },
      }}
    />
  );
}

export function Failed(): JSX.Element {
  return (
    <Login
      view={{
        kind: 'error',
        error: { code: 'LOGIN_FAILED', message: 'Your phone is offline' },
      }}
    />
  );
}
