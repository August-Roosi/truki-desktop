// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { action } from '@storybook/addon-actions';
import type { Meta } from '@storybook/react';

import type { TrukiBanRiskDialogProps } from './TrukiBanRiskDialog.dom.tsx';
import { TrukiBanRiskDialog } from './TrukiBanRiskDialog.dom.tsx';

const { i18n } = window.SignalContext;

export default {
  title: 'Components/Truki/TrukiBanRiskDialog',
} satisfies Meta<TrukiBanRiskDialogProps>;

export function Open(): JSX.Element {
  return (
    <TrukiBanRiskDialog
      i18n={i18n}
      network={{ id: 'whatsapp', name: 'WhatsApp' }}
      onConfirm={action('onConfirm')}
      onCancel={action('onCancel')}
    />
  );
}
