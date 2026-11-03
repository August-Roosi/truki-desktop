// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { action } from '@storybook/addon-actions';
import type { Meta } from '@storybook/react';

import type { TrukiLoginFlowProps } from './TrukiLoginFlow.dom.tsx';
import { TrukiLoginFlow } from './TrukiLoginFlow.dom.tsx';
import type { TrukiLoginView } from '../../util/trukiLoginFlow.std.ts';

const { i18n } = window.SignalContext;

export default {
  title: 'Components/Truki/TrukiLoginFlow',
} satisfies Meta<TrukiLoginFlowProps>;

function Flow({
  view,
  busy = false,
}: Readonly<{ view: TrukiLoginView; busy?: boolean }>): JSX.Element {
  return (
    <div style={{ maxWidth: 520, padding: 24 }}>
      <TrukiLoginFlow
        i18n={i18n}
        networkName="WhatsApp"
        view={view}
        busy={busy}
        onChooseFlow={action('onChooseFlow')}
        onSubmitInput={action('onSubmitInput')}
        onOpenCookieLogin={action('onOpenCookieLogin')}
        onCancel={action('onCancel')}
        onRetry={action('onRetry')}
      />
    </div>
  );
}

export function Qr(): JSX.Element {
  return (
    <Flow
      view={{ kind: 'qr', data: '2@truki-storybook-qr', instructions: '' }}
    />
  );
}

export function PasswordInput(): JSX.Element {
  return (
    <Flow
      view={{
        kind: 'input',
        stepId: 'password',
        instructions: '',
        fields: [
          {
            id: 'password',
            type: 'password',
            name: 'Password',
            description: '',
            defaultValue: '',
            optional: false,
          },
        ],
      }}
    />
  );
}

export function CookiesBusy(): JSX.Element {
  return (
    <Flow busy view={{ kind: 'cookies', stepId: 'c', instructions: '' }} />
  );
}

export function Unsupported(): JSX.Element {
  return (
    <Flow
      view={{
        kind: 'error',
        error: { code: 'UNSUPPORTED_STEP', message: '' },
      }}
    />
  );
}
