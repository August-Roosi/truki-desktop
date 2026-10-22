// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';

import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { LocalizerType } from '../../types/Util.std.ts';

export type TrukiBridgedComposerProps = Readonly<{
  i18n: LocalizerType;
  disabled: boolean;
  // The quoted message's author and preview while replying.
  replyPreview?: Readonly<{ author: string; text: string }>;
  onCancelReply: () => void;
  onSend: (text: string) => void;
  // Resolves true when a file was sent; the draft became its caption.
  onAttach: (caption: string | undefined) => Promise<boolean>;
}>;

// Text entry for a bridged chat: Enter sends, Shift+Enter is a newline.
export const TrukiBridgedComposer = memo(function TrukiBridgedComposer({
  i18n,
  disabled,
  replyPreview,
  onCancelReply,
  onSend,
  onAttach,
}: TrukiBridgedComposerProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [attaching, setAttaching] = useState(false);

  const send = useCallback(() => {
    const text = draft.trim();
    if (disabled || !text) {
      return;
    }
    onSend(text);
    setDraft('');
  }, [disabled, draft, onSend]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        send();
      }
    },
    [send]
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
    },
    []
  );

  // onAttach resolves (never rejects) once the dialog closes.
  const handleAttach = useCallback(async () => {
    setAttaching(true);
    const sent = await onAttach(draft.trim() || undefined);
    setAttaching(false);
    if (sent) {
      setDraft('');
    }
  }, [draft, onAttach]);

  return (
    <div
      data-testid="TrukiBridgedComposer"
      className={tw('shrink-0 border-t border-primary px-4 py-2')}
    >
      {replyPreview && (
        <div
          className={tw(
            'mb-2 flex items-start gap-2 rounded-lg bg-surface-secondary px-3 py-2'
          )}
        >
          <div className={tw('min-w-0 grow border-s-2 border-current ps-2')}>
            <div className={tw('type-body-small font-semibold text-primary')}>
              {replyPreview.author}
            </div>
            <div
              className={tw('truncate type-body-small text-secondary')}
              dir="auto"
            >
              {replyPreview.text}
            </div>
          </div>
          <AxoIconButton.Root
            label={i18n('icu:cancel')}
            variant="implied-secondary"
            size="sm"
            symbol="x"
            onClick={onCancelReply}
          />
        </div>
      )}
      <div className={tw('flex items-end gap-2')}>
        <AxoIconButton.Root
          label={i18n('icu:Keyboard--attach-file')}
          variant="implied-secondary"
          size="md"
          symbol="attach"
          disabled={disabled}
          pending={attaching}
          onClick={() => {
            void handleAttach();
          }}
        />
        <textarea
          aria-label={i18n('icu:sendMessage')}
          placeholder={i18n('icu:sendMessage')}
          dir="auto"
          rows={1}
          value={draft}
          disabled={disabled}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className={tw(
            'max-h-[160px] min-h-[36px] grow resize-none rounded-2xl px-3 py-2',
            'bg-surface-secondary type-body-large text-primary outline-none',
            'field-sizing-content disabled:opacity-50'
          )}
        />
        <AxoIconButton.Root
          label={i18n('icu:TrukiBridgedConversation__Send')}
          variant="strong-primary"
          size="md"
          symbol="send"
          disabled={disabled || draft.trim() === ''}
          onClick={send}
        />
      </div>
    </div>
  );
});
