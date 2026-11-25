// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from 'react';
import type { JSX } from 'react';

import { AxoButton } from '../../axo/AxoButton.dom.tsx';
import { AxoCheckbox } from '../../axo/AxoCheckbox.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { LocalizerType } from '../../types/Util.std.ts';
import { formatTrukiCardAnswer } from '../../util/trukiRichMessage.std.ts';
import type {
  TrukiCard,
  TrukiCardAnswer,
} from '../../util/trukiRichMessage.std.ts';

export type TrukiOptionsCardProps = Readonly<{
  i18n: LocalizerType;
  card: TrukiCard;
  answer: TrukiCardAnswer | null;
  disabled: boolean;
  onAnswer: (body: string) => void;
  onOther: () => void;
}>;

export function TrukiOptionsCard({
  i18n,
  card,
  answer,
  disabled,
  onAnswer,
  onOther,
}: TrukiOptionsCardProps): JSX.Element {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const locked = disabled || answer != null;
  const selected = new Set(answer?.selected ?? []);

  return (
    <div className={tw('mt-2 flex flex-col gap-2')}>
      <div className={tw('type-title-small')} dir="auto">
        {card.question}
      </div>
      <div className={tw('type-caption opacity-70')}>
        {card.multi
          ? i18n('icu:TrukiOptionsCard--ChooseAny')
          : i18n('icu:TrukiOptionsCard--ChooseOne')}
      </div>
      {card.options.map(option =>
        card.multi ? (
          <label key={option.label} className={tw('flex items-start gap-2')}>
            <AxoCheckbox.Root
              variant="square"
              checked={
                answer ? selected.has(option.label) : checked.has(option.label)
              }
              disabled={locked}
              onCheckedChange={next => {
                const updated = new Set(checked);
                if (next) {
                  updated.add(option.label);
                } else {
                  updated.delete(option.label);
                }
                setChecked(updated);
              }}
            />
            <span className={tw('flex min-w-0 flex-col')}>
              <span className={tw('type-body-medium')} dir="auto">
                {option.label}
              </span>
              {option.description ? (
                <span className={tw('type-caption opacity-70')} dir="auto">
                  {option.description}
                </span>
              ) : null}
            </span>
          </label>
        ) : (
          <AxoButton.Root
            key={option.label}
            variant={
              answer && selected.has(option.label)
                ? 'subtle-primary'
                : 'elevated-secondary'
            }
            symbol={answer && selected.has(option.label) ? 'check' : null}
            size="md"
            width="full"
            disabled={locked}
            pressed={answer ? selected.has(option.label) : null}
            onClick={() => {
              onAnswer(formatTrukiCardAnswer(card, [option.label]));
            }}
          >
            <span className={tw('flex min-w-0 flex-col py-1')}>
              <span dir="auto">{option.label}</span>
              {option.description ? (
                <span className={tw('type-caption opacity-70')} dir="auto">
                  {option.description}
                </span>
              ) : null}
            </span>
          </AxoButton.Root>
        )
      )}
      <div className={tw('flex flex-wrap gap-2')}>
        {card.multi ? (
          <AxoButton.Root
            variant="strong-primary"
            size="md"
            disabled={locked || checked.size === 0}
            onClick={() => {
              onAnswer(formatTrukiCardAnswer(card, [...checked]));
            }}
          >
            {i18n('icu:TrukiOptionsCard--Send')}
          </AxoButton.Root>
        ) : null}
        {card.other ? (
          <AxoButton.Root
            variant="subtle-secondary"
            size="md"
            disabled={locked}
            onClick={onOther}
          >
            {i18n('icu:TrukiOptionsCard--Other')}
          </AxoButton.Root>
        ) : null}
      </div>
      {answer ? (
        <div className={tw('type-caption opacity-70')}>
          {i18n('icu:TrukiOptionsCard--Answered')}
          {answer.other ? (
            <div dir="auto">
              {i18n('icu:TrukiOptionsCard--OtherAnswer', {
                text: answer.other,
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
