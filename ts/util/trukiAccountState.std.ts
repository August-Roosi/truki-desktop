// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Account states are mautrix bridgev2 bridge state events
// (maunium.net/go/mautrix@v0.32.0/bridgev2/status/bridgestate.go), plus
// 'UNKNOWN', which the bridge reports before the first state.

export type TrukiAccountStatusKind =
  | 'connected'
  | 'connecting'
  | 'logged-out'
  | 'error';

// States in which the account's chats cannot send or receive. The chat row
// badge and the Connected accounts page both use this set.
const DISCONNECTED_STATES: ReadonlySet<string> = new Set([
  'TRANSIENT_DISCONNECT',
  'BAD_CREDENTIALS',
  'UNKNOWN_ERROR',
  'LOGGED_OUT',
]);

// States in which the account has to be logged in again.
const LOGGED_OUT_STATES: ReadonlySet<string> = new Set([
  'LOGGED_OUT',
  'BAD_CREDENTIALS',
]);

const CONNECTED_STATES: ReadonlySet<string> = new Set([
  'CONNECTED',
  'BACKFILLING',
]);

export function isTrukiAccountDisconnected(state: string): boolean {
  return DISCONNECTED_STATES.has(state);
}

export function isTrukiAccountLoggedOut(state: string): boolean {
  return LOGGED_OUT_STATES.has(state);
}

export function getTrukiAccountStatusKind(
  state: string
): TrukiAccountStatusKind {
  if (CONNECTED_STATES.has(state)) {
    return 'connected';
  }
  if (LOGGED_OUT_STATES.has(state)) {
    return 'logged-out';
  }
  if (DISCONNECTED_STATES.has(state) || state === 'BRIDGE_UNREACHABLE') {
    return 'error';
  }
  // STARTING, CONNECTING, UNKNOWN and anything newer.
  return 'connecting';
}

// Bridge supervisor states in which no bridged chat can send or receive,
// whatever its account last reported (spec §7).
const BRIDGE_DOWN_STATES: ReadonlySet<string> = new Set([
  'backoff',
  'gave-up',
  'unavailable',
]);

export function isTrukiBridgeDown(bridgeState: string): boolean {
  return BRIDGE_DOWN_STATES.has(bridgeState);
}

// The login ids whose chat rows are greyed: those of disconnected accounts,
// and every chat's login while the bridge itself is down.
export function getTrukiDisconnectedLoginIds({
  accounts,
  bridgeState,
  chats,
}: Readonly<{
  accounts: ReadonlyArray<Readonly<{ loginId: string; state: string }>>;
  bridgeState: string;
  chats: ReadonlyArray<Readonly<{ loginId: string }>>;
}>): ReadonlyArray<string> {
  const ids = new Set(
    accounts
      .filter(account => isTrukiAccountDisconnected(account.state))
      .map(account => account.loginId)
  );
  if (isTrukiBridgeDown(bridgeState)) {
    for (const account of accounts) {
      ids.add(account.loginId);
    }
    for (const chat of chats) {
      ids.add(chat.loginId);
    }
  }
  return [...ids];
}
