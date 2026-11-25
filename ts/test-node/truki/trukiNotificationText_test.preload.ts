// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import type { ReadonlyMessageAttributesType } from '../../model-types.d.ts';
import { getNotificationDataForMessage } from '../../util/getNotificationDataForMessage.preload.ts';
import { TRUKI_RICH_MARKER as M } from '../../util/trukiRichMessage.std.ts';

function incoming(body: string): ReadonlyMessageAttributesType {
  return {
    id: 'truki-notification-test',
    conversationId: 'truki-conversation',
    type: 'incoming',
    body,
    sent_at: 1,
    received_at: 1,
    timestamp: 1,
  };
}

describe('Truki rich message notification text', () => {
  it('is the question of a card', () => {
    const { text } = getNotificationDataForMessage(
      incoming(`${M}Intro\n\n\`\`\`options\n? Deploy now?\n- Yes\n- No\n\`\`\``)
    );
    assert.strictEqual(text, 'Deploy now?');
  });

  it('is plain text for markdown', () => {
    const { text } = getNotificationDataForMessage(
      incoming(`${M}# Done\n\n**All** good`)
    );
    assert.strictEqual(text, 'Done\nAll good');
  });

  it('leaves plain bodies unchanged', () => {
    const { text } = getNotificationDataForMessage(incoming('**plain**'));
    assert.strictEqual(text, '**plain**');
  });
});
