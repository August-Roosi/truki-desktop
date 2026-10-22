// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useState } from 'react';
import type { JSX } from 'react';
import { Button } from 'react-aria-components';
import { SentTimestampMs } from '@signalapp/types';

import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';
import { AxoSymbol } from '../../axo/AxoSymbol.dom.tsx';
import { AxoMessage } from '../../axo/message/AxoMessage.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { LocalizerType, ThemeType } from '../../types/Util.std.ts';
import { formatFileSize } from '../../util/formatFileSize.std.ts';
import { formatTime } from '../../util/formatTimestamp.dom.ts';
import { useNowThatUpdatesEveryMinute } from '../../hooks/useNowThatUpdatesEveryMinute.std.ts';
import {
  TRUKI_RATE_LIMITED,
  type TrukiTimelineContent,
  type TrukiTimelineItem,
} from '../../util/trukiBridgedTimeline.std.ts';
import { FunEmojiPicker } from '../fun/FunEmojiPicker.dom.tsx';
import type { FunEmojiSelection } from '../fun/panels/FunPanelEmojis.dom.tsx';
import { TrukiFormattedBody } from './TrukiFormattedBody.dom.tsx';

// A one-line description of a message, for quotes and the reply preview.
export function getTrukiContentPreview(
  i18n: LocalizerType,
  content: TrukiTimelineContent | undefined
): string {
  switch (content?.kind) {
    case 'text':
      return content.body;
    case 'image':
      return i18n('icu:TrukiBridgedConversation__Photo');
    case 'video':
      return i18n('icu:TrukiBridgedConversation__Video');
    case 'file':
      return content.name;
    default:
      return i18n('icu:TrukiBridgedConversation__Unsupported');
  }
}

export type TrukiBridgedMessageBubbleProps = Readonly<{
  i18n: LocalizerType;
  item: TrukiTimelineItem;
  // Who "they" are in quotes: the chat name for a DM.
  otherName: string;
  networkName: string;
  // False while the bridge or the account cannot send.
  canAct: boolean;
  theme?: ThemeType;
  onReply: (eventId: string) => void;
  onReact: (eventId: string, key: string) => void;
  onRemoveReaction: (reactionEventId: string) => void;
  onRequestRedact: (eventId: string) => void;
  onRetry: (eventId: string) => void;
  // This failed message was already sent again (Retry is offered once).
  isRetried?: boolean;
  onSaveFile?: (mxc: string, name: string) => void;
}>;

function MessageContent({
  i18n,
  content,
  onSaveFile,
}: Readonly<{
  i18n: LocalizerType;
  content: TrukiTimelineContent;
  onSaveFile?: (mxc: string, name: string) => void;
}>): JSX.Element {
  switch (content.kind) {
    case 'text':
      return (
        <span
          dir="auto"
          className={tw(
            'type-body-large wrap-break-word whitespace-pre-wrap select-text'
          )}
        >
          <TrukiFormattedBody
            i18n={i18n}
            body={content.body}
            formattedBody={content.formattedBody}
            format={content.format}
          />
        </span>
      );
    case 'image':
    case 'video':
      if (!content.url) {
        return (
          <FileCard
            name={content.body || getTrukiContentPreview(i18n, content)}
          />
        );
      }
      return content.kind === 'image' ? (
        <img
          src={content.url}
          alt={content.body}
          width={content.width}
          height={content.height}
          loading="lazy"
          className={tw(
            'my-1 block size-auto max-h-[320px] max-w-full rounded-lg'
          )}
        />
      ) : (
        <video
          src={content.url}
          controls
          preload="metadata"
          className={tw('my-1 block max-h-[320px] max-w-full rounded-lg')}
        />
      );
    case 'file': {
      const { mxc, name } = content;
      return (
        <FileCard
          name={name}
          size={content.size}
          onSave={mxc && onSaveFile ? () => onSaveFile(mxc, name) : undefined}
          saveLabel={i18n('icu:TrukiBridgedConversation__SaveFile')}
        />
      );
    }
    default:
      return (
        <span className={tw('type-body-medium italic')}>
          {i18n('icu:TrukiBridgedConversation__Unsupported')}
        </span>
      );
  }
}

function FileCard({
  name,
  size,
  onSave,
  saveLabel,
}: Readonly<{
  name: string;
  size?: number;
  onSave?: () => void;
  saveLabel?: string;
}>): JSX.Element {
  return (
    <span
      data-testid="TrukiBridgedFileCard"
      className={tw('my-1 flex min-w-0 items-center gap-2')}
    >
      <AxoSymbol.Icon size={24} symbol="file" label={null} />
      <span className={tw('flex min-w-0 flex-col')}>
        <span className={tw('truncate type-body-medium')} dir="auto">
          {name}
        </span>
        {size !== undefined && (
          <span className={tw('type-caption opacity-70')}>
            {formatFileSize(size)}
          </span>
        )}
      </span>
      {onSave && saveLabel && (
        <AxoIconButton.Root
          label={saveLabel}
          variant="implied-secondary"
          size="sm"
          symbol="download"
          onClick={onSave}
        />
      )}
    </span>
  );
}

// One message: its quote, content, meta (time, edited, status), reactions,
// and the hover actions (reply, react, delete for everyone, retry).
export const TrukiBridgedMessageBubble = memo(
  function TrukiBridgedMessageBubble({
    i18n,
    item,
    otherName,
    networkName,
    canAct,
    theme,
    onReply,
    onReact,
    onRemoveReaction,
    onRequestRedact,
    onRetry,
    isRetried = false,
    onSaveFile,
  }: TrukiBridgedMessageBubbleProps): JSX.Element {
    const [isPickerOpen, setPickerOpen] = useState(false);
    const now = useNowThatUpdatesEveryMinute();
    const direction = item.outgoing ? 'outgoing' : 'incoming';
    const failed = item.status === 'failed';
    const canReply =
      canAct && !item.redacted && !failed && item.status !== 'pending';
    const canDelete =
      canAct &&
      item.outgoing &&
      !item.redacted &&
      (item.status === 'sent' || item.status === '');
    const canRetry = canAct && failed && item.content.kind === 'text';

    const handleReply = useCallback(() => onReply(item.id), [onReply, item.id]);
    const handleDelete = useCallback(
      () => onRequestRedact(item.id),
      [onRequestRedact, item.id]
    );
    const handleRetry = useCallback(() => onRetry(item.id), [onRetry, item.id]);
    const handleSelectEmoji = useCallback(
      (selection: FunEmojiSelection) => {
        onReact(item.id, selection.emoji);
      },
      [onReact, item.id]
    );
    const handleOpenPicker = useCallback(() => setPickerOpen(true), []);

    let statusNode: JSX.Element | undefined;
    if (item.outgoing) {
      if (item.status === 'pending') {
        statusNode = (
          <span title={i18n('icu:TrukiBridgedConversation__Pending')}>
            <AxoMessage.MetaOutgoingStatus status="sending" />
          </span>
        );
      } else if (failed) {
        statusNode = (
          <span className={tw('text-destructive')}>
            <AxoSymbol.InlineGlyph
              symbol="error-circle"
              label={i18n('icu:TrukiBridgedConversation__Failed')}
            />
          </span>
        );
      } else {
        statusNode = (
          <span title={i18n('icu:TrukiBridgedConversation__Sent')}>
            <AxoMessage.MetaOutgoingStatus status="sent" />
          </span>
        );
      }
    }

    const reactLabel = i18n('icu:MessageContextMenu__react');
    const showActions = canReply || canDelete;

    return (
      <div className={tw('group px-4')} data-testid="TrukiBridgedBubble">
        <AxoMessage.Root direction={direction}>
          <div
            className={tw(
              'flex max-w-full min-w-0 flex-col',
              item.outgoing ? 'items-end' : 'items-start'
            )}
          >
            <AxoMessage.Bubble collapseAbove={false} collapseBelow={false}>
              {item.replyTo && (
                <div
                  className={tw(
                    'mb-1 rounded-md border-s-2 border-current px-2 py-1',
                    'bg-material-tertiary type-body-small text-primary'
                  )}
                >
                  {item.replyTo.found && (
                    <div className={tw('font-semibold')}>
                      {item.replyTo.outgoing
                        ? i18n('icu:TrukiBridgedConversation__You')
                        : otherName}
                    </div>
                  )}
                  <div className={tw('line-clamp-2')} dir="auto">
                    {!item.replyTo.found && i18n('icu:originalMessageNotFound')}
                    {item.replyTo.found &&
                      item.replyTo.redacted &&
                      i18n('icu:TrukiBridgedConversation__Deleted')}
                    {item.replyTo.found &&
                      !item.replyTo.redacted &&
                      getTrukiContentPreview(i18n, item.replyTo.content)}
                  </div>
                </div>
              )}
              {item.redacted ? (
                <span className={tw('type-body-large italic')}>
                  {i18n('icu:TrukiBridgedConversation__Deleted')}
                </span>
              ) : (
                <MessageContent
                  i18n={i18n}
                  content={item.content}
                  onSaveFile={onSaveFile}
                />
              )}
              <AxoMessage.Meta>
                {item.edited && (
                  <span>{i18n('icu:MessageMetadata__edited')}</span>
                )}
                <AxoMessage.MetaTimestamp
                  sentAt={SentTimestampMs.fromNumber(
                    Math.max(0, item.timestamp)
                  )}
                >
                  {formatTime(i18n, item.timestamp, now)}
                </AxoMessage.MetaTimestamp>
                {statusNode}
              </AxoMessage.Meta>
            </AxoMessage.Bubble>
            {item.reactions.length > 0 && (
              <div className={tw('mt-0.5 flex flex-wrap gap-1')}>
                {item.reactions.map(reaction => (
                  <button
                    key={reaction.key}
                    type="button"
                    disabled={!canAct || (reaction.mine && !reaction.myEventId)}
                    aria-pressed={reaction.mine}
                    onClick={() => {
                      if (reaction.myEventId) {
                        onRemoveReaction(reaction.myEventId);
                      } else if (!reaction.mine) {
                        onReact(item.id, reaction.key);
                      }
                    }}
                    className={tw(
                      'rounded-full px-2 py-0.5 type-body-small',
                      'bg-surface-secondary text-primary',
                      reaction.mine && 'outline-1 outline-current'
                    )}
                  >
                    {reaction.key}
                    {reaction.count > 1 && ` ${reaction.count}`}
                  </button>
                ))}
              </div>
            )}
            {failed && (
              <div
                className={tw(
                  'mt-0.5 flex items-center gap-2 type-caption text-destructive'
                )}
              >
                <span>
                  {item.errorCode === TRUKI_RATE_LIMITED
                    ? i18n('icu:TrukiBridgedConversation__RateLimited', {
                        network: networkName,
                      })
                    : i18n('icu:TrukiBridgedConversation__Failed')}
                </span>
                {canRetry && isRetried && (
                  <span data-testid="TrukiBridgedRetried">
                    {i18n('icu:TrukiBridgedConversation__SentAgain')}
                  </span>
                )}
                {canRetry && !isRetried && (
                  <button
                    type="button"
                    onClick={handleRetry}
                    className={tw('font-semibold text-accent underline')}
                  >
                    {i18n('icu:TrukiBridgedConversation__Retry')}
                  </button>
                )}
              </div>
            )}
          </div>
          {showActions && (
            <div
              className={tw(
                'flex shrink-0 items-center self-center px-1',
                isPickerOpen
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
              )}
            >
              {canReply && (
                <AxoIconButton.Root
                  label={i18n('icu:MessageContextMenu__reply')}
                  variant="implied-secondary"
                  size="sm"
                  symbol="reply"
                  onClick={handleReply}
                />
              )}
              {canReply &&
                (isPickerOpen ? (
                  // Mounted only while open: one picker, not one per bubble.
                  <FunEmojiPicker
                    open
                    onOpenChange={setPickerOpen}
                    onSelectEmoji={handleSelectEmoji}
                    theme={theme}
                    closeOnSelect
                  >
                    <Button
                      aria-label={reactLabel}
                      className={tw(
                        'flex size-7 items-center justify-center rounded-full text-secondary'
                      )}
                    >
                      <AxoSymbol.Icon size={16} symbol="emoji" label={null} />
                    </Button>
                  </FunEmojiPicker>
                ) : (
                  <AxoIconButton.Root
                    label={reactLabel}
                    variant="implied-secondary"
                    size="sm"
                    symbol="emoji"
                    onClick={handleOpenPicker}
                  />
                ))}
              {canDelete && (
                <AxoIconButton.Root
                  label={i18n('icu:DeleteMessagesModal--deleteForEveryone')}
                  variant="implied-secondary"
                  size="sm"
                  symbol="trash"
                  onClick={handleDelete}
                />
              )}
            </div>
          )}
        </AxoMessage.Root>
      </div>
    );
  }
);
