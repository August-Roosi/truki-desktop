// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { JSX } from 'react';

import { AxoLoadingIndicator } from '../../axo/status/AxoLoadingIndicator.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { LocalizerType, ThemeType } from '../../types/Util.std.ts';
import type { TrukiTimelineItem } from '../../util/trukiBridgedTimeline.std.ts';
import { TrukiBridgedMessageBubble } from './TrukiBridgedMessageBubble.dom.tsx';

// Distance (px) from an edge that still counts as being at it.
const EDGE_THRESHOLD = 80;

export type TrukiBridgedTimelineProps = Readonly<{
  i18n: LocalizerType;
  items: ReadonlyArray<TrukiTimelineItem>;
  hasOlder: boolean;
  loading: boolean;
  isTyping: boolean;
  otherName: string;
  networkName: string;
  canAct: boolean;
  theme?: ThemeType;
  onLoadOlder: () => void;
  // The newest message is on screen (opening the chat, or scrolling down).
  onReachBottom: (newestEventId: string) => void;
  onReply: (eventId: string) => void;
  onReact: (eventId: string, key: string) => void;
  onRemoveReaction: (reactionEventId: string) => void;
  onRequestRedact: (eventId: string) => void;
  onRetry: (eventId: string) => void;
}>;

// Newest at the bottom; scrolling to the top loads older pages, keeping the
// visible messages in place.
export const TrukiBridgedTimeline = memo(function TrukiBridgedTimeline({
  i18n,
  items,
  hasOlder,
  loading,
  isTyping,
  otherName,
  networkName,
  canAct,
  theme,
  onLoadOlder,
  onReachBottom,
  onReply,
  onReact,
  onRemoveReaction,
  onRequestRedact,
  onRetry,
}: TrukiBridgedTimelineProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // Scroll geometry before an older page was prepended.
  const anchorRef = useRef<{ firstId: string; scrollHeight: number } | null>(
    null
  );

  const firstId = items[0]?.id;
  const newestId = items.at(-1)?.id;

  // Runs after every render: content changes (a page, a new message, the
  // typing line) are what move the scroll position.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const anchor = anchorRef.current;
    if (anchor && anchor.firstId !== firstId) {
      // Older messages were prepended: keep the same messages on screen.
      el.scrollTop += el.scrollHeight - anchor.scrollHeight;
      anchorRef.current = null;
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  useEffect(() => {
    if (atBottomRef.current && newestId) {
      onReachBottom(newestId);
    }
  }, [newestId, onReachBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_THRESHOLD;
    if (atBottom && !atBottomRef.current && newestId) {
      onReachBottom(newestId);
    }
    atBottomRef.current = atBottom;
    if (el.scrollTop < EDGE_THRESHOLD && hasOlder && !loading && firstId) {
      anchorRef.current = { firstId, scrollHeight: el.scrollHeight };
      onLoadOlder();
    }
  }, [firstId, hasOlder, loading, newestId, onLoadOlder, onReachBottom]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={tw('min-h-0 grow overflow-y-auto py-2')}
      data-testid="TrukiBridgedTimeline"
    >
      {loading && (
        <div
          role="status"
          aria-label={i18n('icu:TrukiBridgedConversation__Loading')}
          className={tw('flex justify-center py-2 text-secondary')}
        >
          <AxoLoadingIndicator.Root size="sm" />
        </div>
      )}
      {!loading && items.length === 0 && (
        <p className={tw('py-8 text-center type-body-medium text-secondary')}>
          {i18n('icu:TrukiBridgedConversation__Empty')}
        </p>
      )}
      {items.map(item => (
        <TrukiBridgedMessageBubble
          key={item.id}
          i18n={i18n}
          item={item}
          otherName={otherName}
          networkName={networkName}
          canAct={canAct}
          theme={theme}
          onReply={onReply}
          onReact={onReact}
          onRemoveReaction={onRemoveReaction}
          onRequestRedact={onRequestRedact}
          onRetry={onRetry}
        />
      ))}
      {isTyping && (
        <div
          role="status"
          className={tw('px-4 py-1 type-body-small text-secondary italic')}
        >
          {i18n('icu:TrukiBridgedConversation__Typing')}
        </div>
      )}
    </div>
  );
});
