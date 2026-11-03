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
