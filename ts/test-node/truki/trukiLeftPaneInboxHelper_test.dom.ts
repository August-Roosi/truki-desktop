// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import * as sinon from 'sinon';

import type { Row } from '../../components/ConversationList.dom.tsx';
import { RowType } from '../../components/ConversationList.dom.tsx';
import { FindDirection } from '../../components/leftPane/LeftPaneHelper.dom.tsx';
import type { LeftPaneInboxPropsType } from '../../components/leftPane/LeftPaneInboxHelper.dom.tsx';
import { LeftPaneInboxHelper } from '../../components/leftPane/LeftPaneInboxHelper.dom.tsx';
import type { TrukiBridgedChatSummary } from '../../state/ducks/trukiBridge.preload.ts';
import { getDefaultConversation } from '../../test-helpers/getDefaultConversation.std.ts';
import type { LocalizerType } from '../../types/Util.std.ts';

const fakeI18n = ((key: string) => key) as unknown as LocalizerType;

function bridged(id: string, lastActivity: number): TrukiBridgedChatSummary {
  return {
    id,
    network: 'whatsapp',
    loginId: `login-${id}`,
    name: id,
    isDM: true,
    unreadCount: 0,
    lastActivity,
  };
}

// A comparable picture of a row: headers by their text, conversations by id.
function describeRow(row: Row | undefined): string {
  if (!row) {
    return 'none';
  }
  switch (row.type) {
    case RowType.Header:
      return `header:${row.getHeaderText(fakeI18n)}`;
    case RowType.Conversation:
      return `conversation:${row.conversation.id}`;
    case RowType.ArchiveButton:
      return `archive:${row.archivedConversationsCount}`;
    case RowType.TrukiBridgedChat:
      return `truki:${row.chat.id}`;
    default:
      return row.type;
  }
}

function describeRows(helper: LeftPaneInboxHelper): Array<string> {
  const count = helper.getRowCount();
  const rows: Array<string> = [];
  // One past the end, to check it is empty.
  for (let i = 0; i <= count; i += 1) {
    rows.push(describeRow(helper.getRow(i)));
  }
  return rows;
}

describe('LeftPaneInboxHelper (truki bridged chats)', () => {
  const defaultProps: LeftPaneInboxPropsType = {
    archivedConversations: [],
    conversations: [],
    filterByUnread: false,
    isSearchingGlobally: false,
    isAboutToSearch: false,
    pinnedConversations: [],
    searchConversation: undefined,
    searchDisabled: false,
    searchTerm: '',
    startSearchCounter: 0,
    selectedChatFolder: null,
  };

  const pinned1 = getDefaultConversation({ id: 'p1', lastUpdated: 900 });
  const pinned2 = getDefaultConversation({ id: 'p2', lastUpdated: 800 });
  const conv1 = getDefaultConversation({ id: 'c1', lastUpdated: 500 });
  const conv2 = getDefaultConversation({ id: 'c2', lastUpdated: 300 });
  const conv3 = getDefaultConversation({ id: 'c3', lastUpdated: 100 });
  const archived = getDefaultConversation({ id: 'a1', lastUpdated: 50 });

  const fullProps: LeftPaneInboxPropsType = {
    ...defaultProps,
    pinnedConversations: [pinned1, pinned2],
    conversations: [conv1, conv2, conv3],
    archivedConversations: [archived],
  };

  describe('without bridged chats', () => {
    for (const [label, extra] of [
      ['absent', {}],
      ['empty', { trukiBridgedChats: [] }],
      [
        'empty, with every other truki prop set',
        {
          trukiBridgedChats: [],
          trukiSelectedChatId: 'x',
          trukiDisconnectedLoginIds: ['login-x'],
          onSelectTrukiChat: sinon.fake(),
          onTrukiChatMarkRead: sinon.fake(),
          onTrukiChatSetMuted: sinon.fake(),
        },
      ],
    ] as const) {
      it(`behaves exactly as before (${label})`, () => {
        for (const props of [defaultProps, fullProps]) {
          const before = new LeftPaneInboxHelper(props);
          const after = new LeftPaneInboxHelper({ ...props, ...extra });

          assert.strictEqual(after.getRowCount(), before.getRowCount());
          assert.deepEqual(describeRows(after), describeRows(before));
          for (let i = 0; i <= before.getRowCount(); i += 1) {
            assert.strictEqual(after.getRow(i)?.type, before.getRow(i)?.type);
          }
          for (const id of ['p1', 'c1', 'c3', 'a1', 'missing', undefined]) {
            assert.strictEqual(
              after.getRowIndexToScrollTo(id),
              before.getRowIndexToScrollTo(id)
            );
          }
          for (const index of [-1, 0, 1, 2, 3, 4, 99]) {
            assert.deepEqual(
              after.getConversationAndMessageAtIndex(index),
              before.getConversationAndMessageAtIndex(index)
            );
          }
          assert.strictEqual(
            after.requiresFullWidth(),
            before.requiresFullWidth()
          );
        }
      });
    }

    it('keeps the fixture snapshot', () => {
      const helper = new LeftPaneInboxHelper({
        ...fullProps,
        trukiBridgedChats: [],
      });
      assert.deepEqual(describeRows(helper), [
        'header:icu:LeftPane--pinned',
        'conversation:p1',
        'conversation:p2',
        'header:icu:LeftPane--chats',
        'conversation:c1',
        'conversation:c2',
        'conversation:c3',
        'archive:1',
        'none',
      ]);
    });
  });

  describe('with bridged chats', () => {
    const chatX = bridged('x', 400);
    const chatY = bridged('y', 200);

    it('interleaves them into the unpinned section; the archive button stays last', () => {
      const helper = new LeftPaneInboxHelper({
        ...fullProps,
        trukiBridgedChats: [chatY, chatX],
      });

      assert.strictEqual(helper.getRowCount(), 8 + 2);
      assert.deepEqual(describeRows(helper), [
        'header:icu:LeftPane--pinned',
        'conversation:p1',
        'conversation:p2',
        'header:icu:LeftPane--chats',
        'conversation:c1',
        'truki:x',
        'conversation:c2',
        'truki:y',
        'conversation:c3',
        'archive:1',
        'none',
      ]);
    });

    it('works with bridged chats only', () => {
      const helper = new LeftPaneInboxHelper({
        ...defaultProps,
        trukiBridgedChats: [chatX, chatY],
      });

      assert.strictEqual(helper.getRowCount(), 2);
      assert.deepEqual(describeRows(helper), ['truki:x', 'truki:y', 'none']);
    });

    it('shows the "Chats" header when only pinned Signal chats exist', () => {
      const helper = new LeftPaneInboxHelper({
        ...defaultProps,
        pinnedConversations: [pinned1],
        trukiBridgedChats: [chatX],
      });

      assert.deepEqual(describeRows(helper), [
        'header:icu:LeftPane--pinned',
        'conversation:p1',
        'header:icu:LeftPane--chats',
        'truki:x',
        'none',
      ]);
    });

    it('fills in the bridged row props', () => {
      const onSelectTrukiChat = sinon.fake();
      const onTrukiChatMarkRead = sinon.fake();
      const onTrukiChatSetMuted = sinon.fake();
      const helper = new LeftPaneInboxHelper({
        ...defaultProps,
        trukiBridgedChats: [chatX, chatY],
        trukiSelectedChatId: 'y',
        trukiDisconnectedLoginIds: ['login-x'],
        onSelectTrukiChat,
        onTrukiChatMarkRead,
        onTrukiChatSetMuted,
      });

      const rowX = helper.getRow(0);
      const rowY = helper.getRow(1);
      if (
        rowX?.type !== RowType.TrukiBridgedChat ||
        rowY?.type !== RowType.TrukiBridgedChat
      ) {
        assert.fail('expected bridged rows');
      }
      assert.strictEqual(rowX.chat, chatX);
      assert.isFalse(rowX.isSelected);
      assert.isTrue(rowX.isDisconnected);
      assert.isTrue(rowY.isSelected);
      assert.isFalse(rowY.isDisconnected);

      rowX.onSelect('x');
      sinon.assert.calledOnceWithExactly(onSelectTrukiChat, 'x');
      rowX.onMarkRead?.('x');
      sinon.assert.calledOnceWithExactly(onTrukiChatMarkRead, 'x');
      rowX.onSetMuted?.('x', true);
      sinon.assert.calledOnceWithExactly(onTrukiChatSetMuted, 'x', true);
    });

    it('scrolls to a Signal conversation at its merged position', () => {
      const helper = new LeftPaneInboxHelper({
        ...fullProps,
        trukiBridgedChats: [chatX, chatY],
      });

      assert.strictEqual(helper.getRowIndexToScrollTo('p1'), 1);
      assert.strictEqual(helper.getRowIndexToScrollTo('c1'), 4);
      assert.strictEqual(helper.getRowIndexToScrollTo('c2'), 6);
      assert.strictEqual(helper.getRowIndexToScrollTo('c3'), 8);
      assert.isUndefined(helper.getRowIndexToScrollTo('a1'));
      assert.isUndefined(helper.getRowIndexToScrollTo('x'));
      assert.isUndefined(helper.getRowIndexToScrollTo(undefined));
    });

    it('skips bridged rows when picking a conversation by index', () => {
      const helper = new LeftPaneInboxHelper({
        ...fullProps,
        trukiBridgedChats: [chatX, chatY],
      });
      // Merged: p1 p2 | c1 x c2 y c3
      const at = (index: number) =>
        helper.getConversationAndMessageAtIndex(index)?.conversationId;

      assert.strictEqual(at(0), 'p1');
      assert.strictEqual(at(1), 'p2');
      assert.strictEqual(at(2), 'c1');
      assert.strictEqual(at(3), 'c2'); // x → next Signal row
      assert.strictEqual(at(4), 'c2');
      assert.strictEqual(at(5), 'c3'); // y → next Signal row
      assert.strictEqual(at(6), 'c3');
      assert.strictEqual(at(99), 'c3');
      assert.strictEqual(at(-1), 'c3');
    });

    it('falls back to the last Signal row when only bridged rows follow', () => {
      const helper = new LeftPaneInboxHelper({
        ...defaultProps,
        conversations: [conv1],
        trukiBridgedChats: [bridged('z', 1)],
      });
      // Merged: c1 z
      assert.strictEqual(
        helper.getConversationAndMessageAtIndex(1)?.conversationId,
        'c1'
      );
    });

    it('skips bridged rows in next/previous navigation', () => {
      const helper = new LeftPaneInboxHelper({
        ...fullProps,
        trukiBridgedChats: [chatX, chatY],
      });

      assert.deepEqual(
        helper.getConversationAndMessageInDirection(
          { direction: FindDirection.Down, unreadOnly: false },
          'c1',
          undefined
        ),
        { conversationId: 'c2' }
      );
      assert.deepEqual(
        helper.getConversationAndMessageInDirection(
          { direction: FindDirection.Up, unreadOnly: false },
          'c3',
          undefined
        ),
        { conversationId: 'c2' }
      );
    });
  });
});
