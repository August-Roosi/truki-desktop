// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import type { PropsData as ConversationListItemPropsType } from '../../components/conversationList/ConversationListItem.dom.tsx';
import type { TrukiBridgedChatSummary } from '../../state/ducks/trukiBridge.preload.ts';
import {
  trukiMergeChatRows,
  type TrukiMergedRow,
} from '../../util/trukiMergeChatRows.std.ts';

function signal(
  id: string,
  lastUpdated: number | undefined
): ConversationListItemPropsType {
  return {
    id,
    lastUpdated,
    title: id,
    type: 'direct',
    acceptedMessageRequest: true,
    badges: [],
    isMe: false,
    isSelected: false,
    markedUnread: false,
    removalStage: undefined,
    sharedGroupNames: [],
  } as unknown as ConversationListItemPropsType;
}

function bridged(id: string, lastActivity: number): TrukiBridgedChatSummary {
  return {
    id,
    network: 'whatsapp',
    loginId: 'l1',
    name: id,
    isDM: true,
    unreadCount: 0,
    lastActivity,
  };
}

function ids(
  rows: ReadonlyArray<TrukiMergedRow<ConversationListItemPropsType>>
): Array<string> {
  return rows.map(row =>
    row.kind === 'signal' ? `s:${row.conversation.id}` : `t:${row.chat.id}`
  );
}

describe('trukiMergeChatRows', () => {
  it('returns nothing for two empty lists', () => {
    assert.deepEqual(trukiMergeChatRows([], []), []);
  });

  it('returns the Signal rows unchanged when there are no bridged chats', () => {
    const rows = trukiMergeChatRows(
      [signal('a', 30), signal('b', 20), signal('c', 10)],
      []
    );
    assert.deepEqual(ids(rows), ['s:a', 's:b', 's:c']);
  });

  it('returns the bridged rows newest first when there are no Signal rows', () => {
    const rows = trukiMergeChatRows([], [bridged('x', 10), bridged('y', 30)]);
    assert.deepEqual(ids(rows), ['t:y', 't:x']);
  });

  it('interleaves by activity, newest first', () => {
    const rows = trukiMergeChatRows(
      [signal('a', 50), signal('b', 30), signal('c', 10)],
      [bridged('x', 40), bridged('y', 20), bridged('z', 5)]
    );
    assert.deepEqual(ids(rows), ['s:a', 't:x', 's:b', 't:y', 's:c', 't:z']);
  });

  it('puts Signal rows first on equal times, then orders bridged rows by id', () => {
    const rows = trukiMergeChatRows(
      [signal('a', 20)],
      [bridged('y', 20), bridged('x', 20)]
    );
    assert.deepEqual(ids(rows), ['s:a', 't:x', 't:y']);
  });

  it('treats a Signal row without lastUpdated as time 0', () => {
    const rows = trukiMergeChatRows(
      [signal('a', undefined)],
      [bridged('x', 0), bridged('y', 1)]
    );
    assert.deepEqual(ids(rows), ['t:y', 's:a', 't:x']);
  });

  it("keeps Signal's own order even when it is not sorted by time", () => {
    const rows = trukiMergeChatRows(
      [signal('a', 10), signal('b', 30)],
      [bridged('x', 20)]
    );
    assert.deepEqual(ids(rows), ['t:x', 's:a', 's:b']);
  });

  it('carries the original objects', () => {
    const conversation = signal('a', 10);
    const chat = bridged('x', 5);
    const rows = trukiMergeChatRows([conversation], [chat]);
    assert.deepEqual(rows, [
      { kind: 'signal', conversation },
      { kind: 'truki', chat },
    ]);
    assert.strictEqual(
      rows[0]?.kind === 'signal' && rows[0].conversation,
      conversation
    );
  });
});
