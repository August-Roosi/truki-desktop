// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import type { StateType } from '../../state/reducer.preload.ts';
import type {
  TrukiBridgedChatSummary,
  TrukiBridgeStateType,
} from '../../state/ducks/trukiBridge.preload.ts';
import {
  getTrukiBridge,
  getTrukiChatList,
  getTrukiSelectedChatId,
} from '../../state/selectors/trukiBridge.std.ts';

function chat(id: string, lastActivity: number): TrukiBridgedChatSummary {
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

function rootState(partial: Partial<TrukiBridgeStateType>): StateType {
  const trukiBridge: TrukiBridgeStateType = {
    bridgeState: 'running',
    networks: [],
    accounts: [],
    chats: {},
    selectedChatId: undefined,
    messagesByChat: {},
    loginProcesses: {},
    pendingLoginEvents: {},
    typingByChat: {},
    lastError: undefined,
    ...partial,
  };
  return { trukiBridge } as unknown as StateType;
}

describe('trukiBridge selectors', () => {
  it('getTrukiChatList orders by lastActivity desc, ties by id', () => {
    const state = rootState({
      chats: {
        c: chat('c', 10),
        a: chat('a', 20),
        d: chat('d', 30),
        b: chat('b', 20),
      },
    });
    assert.deepEqual(
      getTrukiChatList(state).map(c => c.id),
      ['d', 'a', 'b', 'c']
    );
  });

  it('getTrukiChatList is memoized', () => {
    const state = rootState({ chats: { a: chat('a', 1) } });
    assert.strictEqual(getTrukiChatList(state), getTrukiChatList(state));
  });

  it('getTrukiSelectedChatId and getTrukiBridge read the slice', () => {
    const state = rootState({ selectedChatId: 'a' });
    assert.strictEqual(getTrukiSelectedChatId(state), 'a');
    assert.strictEqual(getTrukiBridge(state).bridgeState, 'running');
  });
});
