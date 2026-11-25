// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Card props for a timeline message that is an agent question card: the
// answered state (derived from the user's quote-replies, never stored), and
// the actions behind its buttons.

import { useMemo } from 'react';
import { useSelector } from 'react-redux';

import type { TrukiCardMessageProps } from '../../components/truki/TrukiRichBody.dom.tsx';
import { drop } from '../../util/drop.std.ts';
import { isNotNil } from '../../util/isNotNil.std.ts';
import { sendTrukiCardAnswer } from '../../util/trukiSendCardAnswer.preload.ts';
import {
  findTrukiCardAnswer,
  getTrukiCardForMessage,
} from '../../util/trukiRichMessage.std.ts';
import type { TrukiCardAnswer } from '../../util/trukiRichMessage.std.ts';
import { useComposerActions } from '../ducks/composer.preload.ts';
import type { StateType } from '../reducer.preload.ts';
import type { TimelineItemType } from '../../components/conversation/TimelineItem.dom.tsx';

function sameAnswer(
  a: TrukiCardAnswer | null,
  b: TrukiCardAnswer | null
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useTrukiCardProps(item: TimelineItemType | undefined): {
  trukiCard?: TrukiCardMessageProps;
} {
  const message = item?.type === 'message' ? item.data : undefined;
  const text = message?.text;
  const conversationId = message?.conversationId;
  const messageId = message?.id;
  const sentAt = message?.timestamp;

  const canReply = message?.canReply;
  const card = useMemo(
    () => getTrukiCardForMessage({ text, canReply }),
    [text, canReply]
  );

  const answer = useSelector((state: StateType): TrukiCardAnswer | null => {
    if (card == null || conversationId == null || sentAt == null) {
      return null;
    }
    const { messagesByConversation, messagesLookup } = state.conversations;
    const ids = messagesByConversation[conversationId]?.messageIds ?? [];
    return findTrukiCardAnswer(
      ids.map(id => messagesLookup[id]).filter(isNotNil),
      card,
      sentAt
    );
  }, sameAnswer);

  const { setQuoteByMessageId } = useComposerActions();

  return useMemo(() => {
    if (card == null || conversationId == null || messageId == null) {
      return {};
    }
    return {
      trukiCard: {
        answer,
        sendAnswer: (body: string) => {
          drop(sendTrukiCardAnswer(conversationId, messageId, body));
        },
        startOtherAnswer: () => {
          setQuoteByMessageId(conversationId, messageId);
        },
      },
    };
  }, [card, conversationId, messageId, answer, setQuoteByMessageId]);
}
