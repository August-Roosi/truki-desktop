// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// The renderer side of the truki-bridge supervisor's IPC
// (app/truki/TrukiBridgeSupervisor.main.ts). Every call resolves with a
// TrukiBridgeIpcResult; none of them throws.

import { ipcRenderer } from 'electron';
import type {
  TrukiBridgeEvent,
  TrukiCookieLoginParams,
  TrukiBridgeIpcResult,
  TrukiPickAttachmentParams,
  TrukiSaveMediaParams,
  TrukiSupervisorStateName,
} from '../../app/truki/trukiBridgeProtocol.std.ts';

function toFailure(error: unknown): TrukiBridgeIpcResult<never> {
  return {
    ok: false,
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function invoke<T>(
  channel: string,
  ...args: ReadonlyArray<unknown>
): Promise<TrukiBridgeIpcResult<T>> {
  try {
    return (await ipcRenderer.invoke(
      channel,
      ...args
    )) as TrukiBridgeIpcResult<T>;
  } catch (error) {
    return toFailure(error);
  }
}

export function trukiBridgeRequest<T>(
  method: string,
  params?: unknown
): Promise<TrukiBridgeIpcResult<T>> {
  return invoke<T>('truki-bridge:request', method, params);
}

export function trukiBridgeGetState(): Promise<
  TrukiBridgeIpcResult<TrukiSupervisorStateName>
> {
  return invoke<TrukiSupervisorStateName>('truki-bridge:get-state');
}

// Stops the bridge if it runs, resets its crash counter and starts it again.
// Progress arrives as event.supervisorState.
export function trukiBridgeRestart(): Promise<TrukiBridgeIpcResult<void>> {
  return invoke<void>('truki-bridge:restart');
}

export function trukiPickAttachment(
  params: TrukiPickAttachmentParams
): Promise<TrukiBridgeIpcResult<{ eventId: string } | { cancelled: true }>> {
  return invoke<{ eventId: string } | { cancelled: true }>(
    'truki-bridge:pick-attachment',
    params
  );
}

// Main shows the save dialog and copies the bridge's media file; the renderer
// names only the media id.
export function trukiSaveMedia(
  params: TrukiSaveMediaParams
): Promise<TrukiBridgeIpcResult<{ saved: true } | { cancelled: true }>> {
  return invoke<{ saved: true } | { cancelled: true }>(
    'truki-bridge:save-media',
    params
  );
}

// The networks main keeps the bridge running for; an empty list stops it.
export function trukiSetEnabledNetworks(
  ids: ReadonlyArray<string>
): Promise<TrukiBridgeIpcResult<void>> {
  return invoke<void>('truki-bridge:set-enabled-networks', ids);
}

// Main opens the login window for the process's current cookies step and
// submits the cookies itself. The result is the login.submit result (the next
// step), never a cookie value.
export function trukiCookieLogin(
  params: TrukiCookieLoginParams
): Promise<
  TrukiBridgeIpcResult<{ cancelled: true } | { step: unknown; seq: number }>
> {
  return invoke<{ cancelled: true } | { step: unknown; seq: number }>(
    'truki-bridge:cookie-login',
    params
  );
}

export function onTrukiBridgeEvent(
  cb: (e: TrukiBridgeEvent) => void
): () => void {
  const listener = (_event: unknown, e: TrukiBridgeEvent) => {
    cb(e);
  };
  ipcRenderer.on('truki-bridge:event', listener);
  return () => {
    ipcRenderer.removeListener('truki-bridge:event', listener);
  };
}
