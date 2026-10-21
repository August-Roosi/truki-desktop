// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// The renderer side of the truki-bridge supervisor's IPC
// (app/truki/TrukiBridgeSupervisor.main.ts). Every call resolves with a
// TrukiBridgeIpcResult; none of them throws.

import { ipcRenderer } from 'electron';
import type {
  TrukiBridgeEvent,
  TrukiBridgeIpcResult,
  TrukiPickAttachmentParams,
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

export function trukiPickAttachment(
  params: TrukiPickAttachmentParams
): Promise<TrukiBridgeIpcResult<{ eventId: string } | { cancelled: true }>> {
  return invoke<{ eventId: string } | { cancelled: true }>(
    'truki-bridge:pick-attachment',
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
