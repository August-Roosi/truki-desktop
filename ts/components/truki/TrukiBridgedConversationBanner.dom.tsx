// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo } from 'react';
import type { JSX } from 'react';

import { AxoButton } from '../../axo/AxoButton.dom.tsx';
import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';
import { AxoSymbol } from '../../axo/AxoSymbol.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { LocalizerType } from '../../types/Util.std.ts';

export type TrukiBridgedConversationBannerProps = Readonly<{
  i18n: LocalizerType;
  tone: 'info' | 'warning' | 'error';
  text: string;
  // Hidden when undefined.
  action?: Readonly<{ label: string; onClick: () => void }>;
  onDismiss?: () => void;
}>;

// One line of status above the timeline: bridge down, account logged out,
// or a failed request.
export const TrukiBridgedConversationBanner = memo(
  function TrukiBridgedConversationBanner({
    i18n,
    tone,
    text,
    action,
    onDismiss,
  }: TrukiBridgedConversationBannerProps): JSX.Element {
    return (
      <div
        role={tone === 'info' ? 'status' : 'alert'}
        data-testid="TrukiBridgedConversationBanner"
        className={tw(
          'flex items-center gap-2 px-4 py-2 type-body-medium',
          'border-b border-primary bg-surface-secondary text-primary'
        )}
      >
        <span
          className={tw(
            'shrink-0',
            tone === 'warning' && 'text-warning',
            tone === 'error' && 'text-destructive',
            tone === 'info' && 'text-secondary'
          )}
        >
          <AxoSymbol.Icon
            size={16}
            symbol={tone === 'info' ? 'info' : 'error-circle'}
            label={null}
          />
        </span>
        <span className={tw('min-w-0 grow')}>{text}</span>
        {action && (
          <AxoButton.Root
            variant="subtle-primary"
            size="sm"
            onClick={action.onClick}
          >
            {action.label}
          </AxoButton.Root>
        )}
        {onDismiss && (
          <AxoIconButton.Root
            label={i18n('icu:TrukiBridgedConversation__Dismiss')}
            tooltip={false}
            variant="implied-secondary"
            size="sm"
            symbol="x"
            onClick={onDismiss}
          />
        )}
      </div>
    );
  }
);
