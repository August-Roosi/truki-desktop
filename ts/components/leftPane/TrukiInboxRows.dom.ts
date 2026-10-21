// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { Row } from '../ConversationList.dom.tsx';
import { RowType } from '../ConversationList.dom.tsx';
import type { PropsData as ConversationListItemPropsType } from '../conversationList/ConversationListItem.dom.tsx';
import type { LeftPaneInboxPropsType } from './LeftPaneInboxHelper.dom.tsx';
import {
  trukiMergeChatRows,
  type TrukiMergedRow,
} from '../../util/trukiMergeChatRows.std.ts';

// The optional props LeftPaneInboxHelper takes for bridged chats.
type TrukiLeftPaneInboxPropsType = Pick<
  LeftPaneInboxPropsType,
  | 'trukiBridgedChats'
  | 'trukiSelectedChatId'
  | 'trukiDisconnectedLoginIds'
  | 'onSelectTrukiChat'
  | 'onTrukiChatMarkRead'
  | 'onTrukiChatSetMuted'
>;

const noop = (): void => undefined;

// The unpinned section of the inbox with bridged chats merged in. Only made
// when there is at least one bridged chat; without one the helper keeps its
// upstream code paths untouched.
export class TrukiInboxRows {
  readonly #rows: ReadonlyArray<TrukiMergedRow<ConversationListItemPropsType>>;
  readonly #props: TrukiLeftPaneInboxPropsType;
  readonly #disconnected: ReadonlySet<string>;

  private constructor(
    rows: ReadonlyArray<TrukiMergedRow<ConversationListItemPropsType>>,
    props: TrukiLeftPaneInboxPropsType
  ) {
    this.#rows = rows;
    this.#props = props;
    this.#disconnected = new Set(props.trukiDisconnectedLoginIds ?? []);
  }

  static create(
    conversations: ReadonlyArray<ConversationListItemPropsType>,
    props: TrukiLeftPaneInboxPropsType
  ): TrukiInboxRows | undefined {
    const bridged = props.trukiBridgedChats;
    if (!bridged || bridged.length === 0) {
      return undefined;
    }
    return new TrukiInboxRows(
      trukiMergeChatRows(conversations, bridged),
      props
    );
  }

  get length(): number {
    return this.#rows.length;
  }

  getRow(index: number): undefined | Row {
    const row = this.#rows[index];
    if (!row) {
      return undefined;
    }
    if (row.kind === 'signal') {
      return { type: RowType.Conversation, conversation: row.conversation };
    }
    const { chat } = row;
    const {
      trukiSelectedChatId,
      onSelectTrukiChat,
      onTrukiChatMarkRead,
      onTrukiChatSetMuted,
    } = this.#props;
    return {
      type: RowType.TrukiBridgedChat,
      chat,
      isSelected: trukiSelectedChatId === chat.id,
      isDisconnected: this.#disconnected.has(chat.loginId),
      onSelect: onSelectTrukiChat ?? noop,
      onMarkRead: onTrukiChatMarkRead,
      onSetMuted: onTrukiChatSetMuted,
    };
  }

  // Index of a Signal conversation in the merged list, or -1.
  indexOfConversation(conversationId: string): number {
    return this.#rows.findIndex(
      row => row.kind === 'signal' && row.conversation.id === conversationId
    );
  }

  // The Signal conversation at `index`, or the first one after it when that
  // row is bridged; keyboard shortcuts only ever pick Signal conversations.
  conversationAtOrAfter(
    index: number
  ): undefined | ConversationListItemPropsType {
    for (let i = Math.max(index, 0); i < this.#rows.length; i += 1) {
      const row = this.#rows[i];
      if (row?.kind === 'signal') {
        return row.conversation;
      }
    }
    return undefined;
  }
}
