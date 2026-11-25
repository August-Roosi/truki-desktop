// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Sends an answer to an agent's question card as a quote-reply to the card.

import { createLogger } from '../logging/log.std.ts';
import { getMessageById } from '../messages/getMessageById.preload.ts';
import * as Errors from '../types/errors.std.ts';
import { makeQuote } from './makeQuote.preload.ts';
import { getTrukiRichPlainText } from './trukiMarkdown.std.ts';

const log = createLogger('trukiSendCardAnswer');

export async function sendTrukiCardAnswer(
  conversationId: string,
  cardMessageId: string,
  body: string
): Promise<void> {
  try {
    const conversation = window.ConversationController.get(conversationId);
    const message = await getMessageById(cardMessageId);
    if (!conversation || !message) {
      log.error('sendTrukiCardAnswer: conversation or card message missing');
      return;
    }
    const quote = await makeQuote(message.attributes);
    await conversation.enqueueMessageForSend(
      {
        body,
        attachments: [],
        // Quote the question, not the raw options block, so the quote also
        // reads cleanly in official Signal clients.
        quote: {
          ...quote,
          text: getTrukiRichPlainText(message.attributes.body ?? ''),
          bodyRanges: [],
        },
        preview: [],
        bodyRanges: [],
      },
      // Answering a card must not wipe what the user is typing.
      { dontClearDraft: true }
    );
  } catch (error) {
    log.error('sendTrukiCardAnswer: failed', Errors.toLogFormat(error));
  }
}
