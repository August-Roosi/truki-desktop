// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';

import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { LocalizerType } from '../../types/Util.std.ts';

type PropsType = Readonly<{
  i18n: LocalizerType;
  onBack: () => void;
}>;

export function TrukiSettingsHeader({ i18n, onBack }: PropsType): JSX.Element {
  return (
    <header
      className={tw(
        'col-span-full -mx-11 grid min-h-[calc(70px+var(--title-bar-drag-area-height))]',
        'w-[calc(100%+5.5rem)]',
        'grid-cols-[52px_1fr_52px] items-end border-b border-primary px-5 pb-2',
        'pt-(--title-bar-drag-area-height)'
      )}
    >
      <AxoIconButton.Root
        label={i18n('icu:NavSidebar__BackButtonLabel')}
        variant="implied-secondary"
        size="lg"
        symbol="chevron-[start]"
        onClick={onBack}
      />
      <h1 className={tw('m-0 pb-2 text-center type-title-medium')}>
        {i18n('icu:Preferences--header')}
      </h1>
      <span />
    </header>
  );
}
