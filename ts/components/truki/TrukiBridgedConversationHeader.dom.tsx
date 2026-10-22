// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback } from 'react';
import type { JSX } from 'react';

import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { LocalizerType } from '../../types/Util.std.ts';

export type TrukiBridgedConversationHeaderProps = Readonly<{
  i18n: LocalizerType;
  name: string;
  networkName: string;
  accountName?: string;
  isMuted: boolean;
  onSetMuted: (muted: boolean) => void;
}>;

// Name, network and account of a bridged chat, with its mute toggle.
export const TrukiBridgedConversationHeader = memo(
  function TrukiBridgedConversationHeader({
    i18n,
    name,
    networkName,
    accountName,
    isMuted,
    onSetMuted,
  }: TrukiBridgedConversationHeaderProps): JSX.Element {
    const handleToggleMute = useCallback(() => {
      onSetMuted(!isMuted);
    }, [onSetMuted, isMuted]);

    return (
      <header
        className={tw(
          'flex h-[52px] shrink-0 items-center gap-3 px-4',
          'border-b border-primary'
        )}
      >
        <div className={tw('flex min-w-0 grow flex-col')}>
          <h2 className={tw('truncate type-title-small text-primary')} dir="auto">
            {name}
          </h2>
          <span className={tw('truncate type-caption text-secondary')}>
            {accountName
              ? i18n('icu:TrukiBridgedConversation__NetworkAccount', {
                  network: networkName,
                  account: accountName,
                })
              : networkName}
          </span>
        </div>
        <AxoIconButton.Root
          label={isMuted ? i18n('icu:unmute') : i18n('icu:muteNotificationsTitle')}
          variant="implied-secondary"
          size="md"
          symbol={isMuted ? 'bell-slash' : 'bell'}
          pressed={isMuted}
          onClick={handleToggleMute}
        />
      </header>
    );
  }
);
