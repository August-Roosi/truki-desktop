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

// Emitted to the renderer by the supervisor on every state change, as
// { method: 'event.supervisorState', params: { state } }. 'unavailable' means
// secure storage (Electron safeStorage) is not available.
export type TrukiSupervisorStateName =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'backoff'
  | 'gave-up'
  | 'unavailable';

export type TrukiSupervisorStateEvent = {
  method: 'event.supervisorState';
  params: { state: TrukiSupervisorStateName };
};

const MXC_RE = /^mxc:\/\/truki\.local\/([0-9a-f]{64})$/i;
const MEDIA_URL_RE = /^truki-media:\/\/truki\.local\/([0-9a-f]{64})$/i;

// mxc://truki.local/<64 hex> -> truki-media://truki.local/<64 hex>.
// The host is lowercased; anything that is not a bridge media id is refused.
export function mxcToTrukiMediaUrl(mxc: string): string | undefined {
  const id = MXC_RE.exec(mxc)?.[1];
  return id ? `truki-media://truki.local/${id.toLowerCase()}` : undefined;
}

// The exact inverse of mxcToTrukiMediaUrl.
export function trukiMediaUrlToMxc(url: string): string | undefined {
  const id = MEDIA_URL_RE.exec(url)?.[1];
  return id ? `mxc://truki.local/${id.toLowerCase()}` : undefined;
}

export type TrukiPickAttachmentParams = {
  chatId: string;
  caption?: string;
  replyTo?: string;
};

export type TrukiSaveMediaParams = {
  mxc: string;
  suggestedName?: string;
};

// truki-bridge:cookie-login. The login URL and cookie names come from the
// step the bridge reported for the process, not from the caller.
export type TrukiCookieLoginParams = {
  processId: string;
  stepId: string;
};

// What the truki-bridge IPC handlers return. They never throw.
export type TrukiBridgeIpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: TrukiBridgeErrorCode;
      bridgeCode?: string;
      message: string;
    };
