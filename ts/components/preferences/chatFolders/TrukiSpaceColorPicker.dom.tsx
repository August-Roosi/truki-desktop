// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';

import { tw } from '../../../axo/tw.dom.tsx';
import type { LocalizerType } from '../../../types/I18N.std.ts';
import * as TrukiSpaceColor from '../../../types/TrukiSpaceColor.std.ts';

export type TrukiSpaceColorPickerProps = Readonly<{
  value: number | null;
  onChange: (value: number | null) => void;
  i18n: LocalizerType;
}>;

/** A fixed, keyboard-accessible colour palette for a Truki space. */
export function TrukiSpaceColorPicker(
  props: TrukiSpaceColorPickerProps
): JSX.Element {
  const { i18n, onChange, value } = props;
  const colorLabel = i18n(
    'icu:Preferences__EditChatFolderPage__Color__Label'
  );

  return (
    <div
      className={tw('flex flex-wrap gap-2')}
      role="group"
      aria-label={colorLabel}
    >
      <button
        type="button"
        aria-label={i18n(
          'icu:Preferences__EditChatFolderPage__Color__None'
        )}
        aria-pressed={value == null}
        className={tw(
          'flex size-8 items-center justify-center rounded-full border border-secondary',
          'bg-primary outline-none keyboard-mode:focus:axo-focus-ring',
          value == null &&
            'ring-[2.5px] ring-(--axo-color-border-focused-outer) ring-offset-2'
        )}
        onClick={() => onChange(null)}
      >
        <span className={tw('text-secondary')}>×</span>
      </button>
      {TrukiSpaceColor.PALETTE.map(option => {
        return (
          <button
            key={option.key}
            type="button"
            aria-label={`${colorLabel}: ${option.key}`}
            aria-pressed={value === option.value}
            className={tw(
              'size-8 rounded-full outline-none keyboard-mode:focus:axo-focus-ring',
              value === option.value &&
                'ring-[2.5px] ring-(--axo-color-border-focused-outer) ring-offset-2'
            )}
            style={{ backgroundColor: TrukiSpaceColor.toCssHex(option.value) }}
            onClick={() => onChange(option.value)}
          />
        );
      })}
    </div>
  );
}
