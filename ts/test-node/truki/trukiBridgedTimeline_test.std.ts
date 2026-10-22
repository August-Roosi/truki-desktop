// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import type { TrukiBridgedEvent } from '../../state/ducks/trukiBridge.preload.ts';
import {
  buildTrukiTimeline,
  getTrukiConversationBanner,
  getTrukiNetworkDisplayName,
} from '../../util/trukiBridgedTimeline.std.ts';

const ME = '@me:truki.local';
const THEM = '@whatsapp_1:truki.local';
const HASH = 'a'.repeat(64);

let order = 0;
function event(
  id: string,
  overrides: Partial<TrukiBridgedEvent> = {}
): TrukiBridgedEvent {
  order += 1;
  return {
    id,
    chatId: '!a:truki.local',
    sender: THEM,
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: `body of ${id}` },
    timestamp: 1000 + order,
    streamOrder: order,
    status: '',
    redacted: false,
    ...overrides,
  };
}

function edit(id: string, target: string, body: string, sender = THEM) {
  return event(id, {
    sender,
    relatesTo: target,
    relType: 'm.replace',
    content: {
      msgtype: 'm.text',
      body: `* ${body}`,
      'm.new_content': { msgtype: 'm.text', body },
      'm.relates_to': { rel_type: 'm.replace', event_id: target },
    },
  });
}

function reaction(
  id: string,
  target: string,
  key: string,
  overrides: Partial<TrukiBridgedEvent> = {}
) {
  return event(id, {
    type: 'm.reaction',
    relatesTo: target,
    relType: 'm.annotation',
    content: {
      'm.relates_to': { rel_type: 'm.annotation', event_id: target, key },
    },
    ...overrides,
  });
}

describe('trukiBridgedTimeline buildTrukiTimeline', () => {
  it('shows the latest edit as the text, with an edited flag', () => {
    const first = event('$1');
    const early = edit('$e1', '$1', 'first');
    const late = edit('$e2', '$1', 'second');
    const second = event('$2');
    // The array order does not matter; stream order does.
    const items = buildTrukiTimeline([first, late, early, second], ME);
    assert.deepEqual(
      items.map(i => i.id),
      ['$1', '$2']
    );
    assert.isTrue(items[0]?.edited);
    assert.deepEqual(items[0]?.content, { kind: 'text', body: 'second' });
  });

  it('ignores an edit by someone else or a redacted edit', () => {
    const items = buildTrukiTimeline(
      [
        event('$1'),
        edit('$e1', '$1', 'not theirs', ME),
        { ...edit('$e2', '$1', 'gone'), redacted: true },
      ],
      ME
    );
    assert.isFalse(items[0]?.edited);
    assert.deepEqual(items[0]?.content, { kind: 'text', body: 'body of $1' });
  });

  it('aggregates reactions per key and marks mine', () => {
    const items = buildTrukiTimeline(
      [
        event('$1'),
        reaction('$r1', '$1', '👍'),
        reaction('$r2', '$1', '👍', { sender: ME, status: 'sent' }),
        reaction('$r3', '$1', '❤️'),
        reaction('$r4', '$1', '😂', { sender: ME, status: 'failed' }),
        reaction('$r5', '$1', '😮', { redacted: true }),
      ],
      ME
    );
    assert.deepEqual(items[0]?.reactions, [
      { key: '👍', count: 2, mine: true, myEventId: '$r2' },
      { key: '❤️', count: 1, mine: false },
    ]);
  });

  it('a redacted message has no content, reactions or edited flag', () => {
    const items = buildTrukiTimeline(
      [
        event('$1', { redacted: true, content: {} }),
        edit('$e1', '$1', 'edited'),
        reaction('$r1', '$1', '👍'),
      ],
      ME
    );
    assert.lengthOf(items, 1);
    assert.isTrue(items[0]?.redacted);
    assert.isFalse(items[0]?.edited);
    assert.deepEqual(items[0]?.reactions, []);
    assert.deepEqual(items[0]?.content, { kind: 'unsupported' });
  });

  it('resolves a reply to its target, or marks it missing', () => {
    const replyContent = (target: string) => ({
      msgtype: 'm.text',
      body: 'reply',
      'm.relates_to': { 'm.in_reply_to': { event_id: target } },
    });
    const items = buildTrukiTimeline(
      [
        event('$1', { sender: ME, status: 'sent' }),
        edit('$e1', '$1', 'edited target', ME),
        event('$2', { content: replyContent('$1') }),
        event('$3', { content: replyContent('$missing') }),
      ],
      ME
    );
    assert.deepEqual(items[1]?.replyTo, {
      id: '$1',
      found: true,
      outgoing: true,
      redacted: false,
      content: { kind: 'text', body: 'edited target' },
    });
    assert.deepEqual(items[2]?.replyTo, {
      id: '$missing',
      found: false,
      outgoing: false,
      redacted: false,
    });
  });

  it('parses media and files', () => {
    const items = buildTrukiTimeline(
      [
        event('$img', {
          content: {
            msgtype: 'm.image',
            body: 'photo.jpg',
            url: `mxc://truki.local/${HASH}`,
            info: { w: 640, h: 480 },
          },
        }),
        event('$bad', {
          content: {
            msgtype: 'm.video',
            body: 'v.mp4',
            url: 'mxc://elsewhere.org/x',
          },
        }),
        event('$file', {
          content: {
            msgtype: 'm.file',
            body: 'report.pdf',
            info: { size: 2048 },
          },
        }),
      ],
      ME
    );
    assert.deepEqual(items[0]?.content, {
      kind: 'image',
      body: 'photo.jpg',
      url: `truki-media://truki.local/${HASH}`,
      width: 640,
      height: 480,
    });
    assert.deepEqual(items[1]?.content, { kind: 'video', body: 'v.mp4' });
    assert.deepEqual(items[2]?.content, {
      kind: 'file',
      name: 'report.pdf',
      size: 2048,
    });
  });

  it('marks outgoing by sender or status and skips non-messages', () => {
    const items = buildTrukiTimeline(
      [
        event('$1', { sender: ME }),
        event('$truki-2', { sender: '', status: 'pending' }),
        event('$3'),
        event('$redaction', { type: 'm.room.redaction', content: {} }),
      ],
      ME
    );
    assert.deepEqual(
      items.map(i => [i.id, i.outgoing]),
      [
        ['$1', true],
        ['$truki-2', true],
        ['$3', false],
      ]
    );
  });
});

describe('trukiBridgedTimeline getTrukiConversationBanner', () => {
  it('maps bridge and account states', () => {
    assert.strictEqual(
      getTrukiConversationBanner('starting', 'CONNECTED'),
      'bridge-starting'
    );
    for (const state of [
      'stopped',
      'backoff',
      'gave-up',
      'unavailable',
    ] as const) {
      assert.strictEqual(
        getTrukiConversationBanner(state, 'LOGGED_OUT'),
        'bridge-down'
      );
    }
    assert.strictEqual(
      getTrukiConversationBanner('running', 'LOGGED_OUT'),
      'logged-out'
    );
    assert.strictEqual(
      getTrukiConversationBanner('running', 'BAD_CREDENTIALS'),
      'logged-out'
    );
    assert.isUndefined(getTrukiConversationBanner('running', 'CONNECTED'));
    assert.isUndefined(getTrukiConversationBanner('running', undefined));
  });
});

describe('trukiBridgedTimeline getTrukiNetworkDisplayName', () => {
  it('prefers the bridge name, then a known name, then the id', () => {
    assert.strictEqual(
      getTrukiNetworkDisplayName('whatsapp', [
        { id: 'whatsapp', name: 'WhatsApp Business' },
      ]),
      'WhatsApp Business'
    );
    assert.strictEqual(
      getTrukiNetworkDisplayName('instagram', []),
      'Instagram'
    );
    assert.strictEqual(getTrukiNetworkDisplayName('signalx', []), 'signalx');
  });
});
