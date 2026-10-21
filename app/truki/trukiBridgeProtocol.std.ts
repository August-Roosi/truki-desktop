// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Wire-level types shared by the supervisor and (later) the renderer.
// See truki-bridge/PROTOCOL.md.

export const TRUKI_BRIDGE_PROTOCOL_VERSION = 1;

export type TrukiBridgeErrorCode =
  | 'NOT_INITIALIZED'
  | 'NOT_LOGGED_IN'
  | 'NETWORK_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'INTERNAL'
  | 'BRIDGE_UNAVAILABLE'
  | 'BRIDGE_INCOMPATIBLE'
  | 'BRIDGE_STOPPED';

const KNOWN_CODES: ReadonlySet<string> = new Set<TrukiBridgeErrorCode>([
  'NOT_INITIALIZED',
  'NOT_LOGGED_IN',
  'NETWORK_UNAVAILABLE',
  'RATE_LIMITED',
  'INVALID_INPUT',
  'NOT_FOUND',
  'INTERNAL',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_INCOMPATIBLE',
  'BRIDGE_STOPPED',
]);

export function isTrukiBridgeErrorCode(
  value: unknown
): value is TrukiBridgeErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value);
}

export class TrukiBridgeError extends Error {
  public code: TrukiBridgeErrorCode;

  // The bridge's own `data.code` when it is not one of the codes above
  // (for example LOGIN_FAILED); `code` is INTERNAL in that case.
  public bridgeCode: string | undefined;

  constructor(
    code: TrukiBridgeErrorCode,
    message: string,
    bridgeCode?: string
  ) {
    super(message);
    this.name = 'TrukiBridgeError';
    this.code = code;
    this.bridgeCode = bridgeCode;
  }
}

export type TrukiBridgeEvent = { method: `event.${string}`; params: unknown };
