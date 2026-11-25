// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  findTrukiCardAnswer,
  getTrukiCardForMessage,
  isTrukiMarkdownSafe,
  shouldRenderTrukiRich,
  TRUKI_RICH_MARKER,
} from '../../util/trukiRichMessage.std.ts';
import type { TrukiCard } from '../../util/trukiRichMessage.std.ts';

const CARD: TrukiCard = {
  question: 'q',
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
  ],
  multi: false,
  other: false,
};

function out(sentAt: number, body: string, quoteId: number | null = 100) {
  return { type: 'outgoing', sent_at: sentAt, body, quote: { id: quoteId } };
}

describe('findTrukiCardAnswer', () => {
  it('picks the newest outgoing quote', () => {
    const answer = findTrukiCardAnswer(
      [out(200, '✅ A'), out(300, '✅ B')],
      CARD,
      100
    );
    assert.deepEqual(answer, { selected: ['B'], other: null });
  });

  it('ignores incoming messages and other quotes', () => {
    assert.isNull(
      findTrukiCardAnswer(
        [
          { type: 'incoming', sent_at: 300, body: '✅ B', quote: { id: 100 } },
          out(400, '✅ A', 101),
          out(500, '✅ A', null),
          { type: 'outgoing', sent_at: 600, body: '✅ A' },
        ],
        CARD,
        100
      )
    );
  });

  it('skips an unresolvable newer answer', () => {
    assert.deepEqual(
      findTrukiCardAnswer([out(200, '✅ A'), out(300, '✅ Nope')], CARD, 100),
      { selected: ['A'], other: null }
    );
  });

  it('is null without answers', () => {
    assert.isNull(findTrukiCardAnswer([], CARD, 100));
  });
});

describe('shouldRenderTrukiRich', () => {
  it('renders marker bodies', () => {
    assert.isTrue(shouldRenderTrukiRich(`${TRUKI_RICH_MARKER}# x`, false));
  });

  it('renders plain path while long-text attachment is pending', () => {
    assert.isFalse(shouldRenderTrukiRich(`${TRUKI_RICH_MARKER}# x`, true));
  });

  it('leaves plain bodies alone', () => {
    assert.isFalse(shouldRenderTrukiRich('# x', false));
    assert.isFalse(shouldRenderTrukiRich(undefined, false));
  });
});

const CARD_TEXT = `${TRUKI_RICH_MARKER}\`\`\`options\n? Q\n- A\n- B\n\`\`\``;

describe('isTrukiMarkdownSafe', () => {
  it('accepts an ordinary report', () => {
    assert.isTrue(
      isTrukiMarkdownSafe(
        '# Report\n\n- **a**\n  - b\n\n> quote\n\n| x | y |\n|---|---|'
      )
    );
  });

  it('rejects deep list and quote nesting', () => {
    assert.isFalse(isTrukiMarkdownSafe(`${'- '.repeat(5000)}a`));
    assert.isFalse(isTrukiMarkdownSafe('>'.repeat(10000)));
    assert.isFalse(isTrukiMarkdownSafe(`${'1. '.repeat(20)}a`));
    const staircase = Array.from(
      { length: 40 },
      (_, i) => `${' '.repeat(i * 2)}- a`
    ).join('\n');
    assert.isFalse(isTrukiMarkdownSafe(staircase));
  });

  it('rejects long input and emphasis floods', () => {
    assert.isFalse(isTrukiMarkdownSafe('a'.repeat(8001)));
    assert.isFalse(isTrukiMarkdownSafe('*a'.repeat(700)));
    assert.isTrue(isTrukiMarkdownSafe('**bold** '.repeat(100)));
  });

  it('keeps rich rendering off for unsafe bodies', () => {
    assert.isFalse(
      shouldRenderTrukiRich(`${TRUKI_RICH_MARKER}${'- '.repeat(5000)}a`, false)
    );
  });
});

describe('getTrukiCardForMessage', () => {
  it('returns the card when the user can reply', () => {
    assert.strictEqual(
      getTrukiCardForMessage({ text: CARD_TEXT, canReply: true })?.question,
      'Q'
    );
  });

  it('returns no card without canReply', () => {
    assert.isNull(getTrukiCardForMessage({ text: CARD_TEXT, canReply: false }));
    assert.isNull(getTrukiCardForMessage({ text: CARD_TEXT }));
  });

  it('returns no card for an unsafe body', () => {
    assert.isNull(
      getTrukiCardForMessage({
        text: `${CARD_TEXT}\n\n${'*a'.repeat(700)}`,
        canReply: true,
      })
    );
  });
});
