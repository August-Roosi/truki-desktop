// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import * as sinon from 'sinon';

import { trukiSelectBridgedChat } from '../../util/trukiBridgedSelection.std.ts';

describe('trukiSelectBridgedChat', () => {
  it("clears Signal's selection, then selects the bridged chat", () => {
    const calls: Array<string> = [];
    const showConversation = sinon.spy((_options: unknown) => {
      calls.push('showConversation');
    });
    const selectBridgedChat = sinon.spy((_chatId: string) => {
      calls.push('selectBridgedChat');
    });

    trukiSelectBridgedChat('chat-1', { showConversation, selectBridgedChat });

    sinon.assert.calledOnceWithExactly(showConversation, {
      conversationId: undefined,
    });
    sinon.assert.calledOnceWithExactly(selectBridgedChat, 'chat-1');
    assert.deepEqual(calls, ['showConversation', 'selectBridgedChat']);
  });
});
