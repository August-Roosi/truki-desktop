// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  getTrukiDisconnectedLoginIds,
  isTrukiBridgeDown,
} from '../../util/trukiAccountState.std.ts';

describe('getTrukiDisconnectedLoginIds', () => {
  const accounts = [
    { loginId: 'ok', state: 'CONNECTED' },
    { loginId: 'lost', state: 'TRANSIENT_DISCONNECT' },
  ];
  const chats = [{ loginId: 'ok' }, { loginId: 'lost' }, { loginId: 'orphan' }];

  it('greys only disconnected accounts while the bridge runs', () => {
    assert.sameMembers(
      [
        ...getTrukiDisconnectedLoginIds({
          accounts,
          bridgeState: 'running',
          chats,
        }),
      ],
      ['lost']
    );
  });

  for (const bridgeState of ['backoff', 'gave-up', 'unavailable']) {
    it(`greys every row when the bridge is ${bridgeState}`, () => {
      assert.sameMembers(
        [...getTrukiDisconnectedLoginIds({ accounts, bridgeState, chats })],
        ['ok', 'lost', 'orphan']
      );
    });
  }

  it('treats only backoff, gave-up and unavailable as down', () => {
    assert.isTrue(isTrukiBridgeDown('gave-up'));
    assert.isFalse(isTrukiBridgeDown('running'));
    assert.isFalse(isTrukiBridgeDown('starting'));
    assert.isFalse(isTrukiBridgeDown('stopped'));
  });
});
