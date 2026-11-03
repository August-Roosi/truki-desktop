// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// What the Connected accounts page shows for a network's login: derived from
// the duck's login attempt and the bridge's current step (bridgev2
// LoginStep, see truki-bridge/PROTOCOL.md "Login and accounts").

import type {
  TrukiBridgeLoginError,
  TrukiBridgeStateType,
  TrukiLoginAttempt,
  TrukiLoginFlow,
} from '../state/ducks/trukiBridge.preload.ts';

export type TrukiLoginInputField = Readonly<{
  id: string;
  type: string;
  name: string;
  description: string;
  defaultValue: string;
  optional: boolean;
  pattern?: string;
  options?: ReadonlyArray<string>;
}>;

export type TrukiLoginView = Readonly<
  | { kind: 'waiting'; instructions: string }
  | { kind: 'choose-flow'; flows: ReadonlyArray<TrukiLoginFlow> }
  | { kind: 'qr'; data: string; instructions: string }
  | { kind: 'code'; code: string; instructions: string }
  | {
      kind: 'input';
      stepId: string;
      fields: ReadonlyArray<TrukiLoginInputField>;
      instructions: string;
    }
  | { kind: 'cookies'; stepId: string; instructions: string }
  | { kind: 'complete' }
  | { kind: 'error'; error: TrukiBridgeLoginError }
>;

// The bridge gave up waiting (an unscanned QR code, an idle process).
export const TRUKI_LOGIN_EXPIRED = 'LOGIN_EXPIRED';
// A step type this client cannot drive (client_http, webauthn, ...).
export const TRUKI_LOGIN_UNSUPPORTED = 'UNSUPPORTED_STEP';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseField(value: unknown): TrukiLoginInputField | undefined {
  if (!isRecord(value) || !str(value.id)) {
    return undefined;
  }
  const pattern = str(value.pattern);
  const options = Array.isArray(value.options)
    ? value.options.filter((o): o is string => typeof o === 'string')
    : [];
  return {
    id: str(value.id),
    type: str(value.type),
    name: str(value.name) || str(value.id),
    description: str(value.description),
    defaultValue: str(value.default_value),
    optional: value.optional === true,
    ...(pattern ? { pattern } : {}),
    ...(options.length ? { options } : {}),
  };
}

function unsupported(): TrukiLoginView {
  return {
    kind: 'error',
    error: { code: TRUKI_LOGIN_UNSUPPORTED, message: '' },
  };
}

export function parseTrukiLoginStep(step: unknown): TrukiLoginView {
  if (!isRecord(step)) {
    return unsupported();
  }
  const instructions = str(step.instructions);
  const stepId = str(step.step_id);
  switch (step.type) {
    case 'display_and_wait': {
      const params = isRecord(step.display_and_wait)
        ? step.display_and_wait
        : {};
      const data = str(params.data);
      if (params.type === 'qr' && data) {
        return { kind: 'qr', data, instructions };
      }
      if ((params.type === 'code' || params.type === 'emoji') && data) {
        return { kind: 'code', code: data, instructions };
      }
      return { kind: 'waiting', instructions };
    }
    case 'user_input': {
      const params = isRecord(step.user_input) ? step.user_input : {};
      const fields = Array.isArray(params.fields)
        ? params.fields
            .map(parseField)
            .filter((f): f is TrukiLoginInputField => f !== undefined)
        : [];
      if (!stepId || fields.length === 0) {
        return unsupported();
      }
      return { kind: 'input', stepId, fields, instructions };
    }
    case 'cookies':
      return stepId ? { kind: 'cookies', stepId, instructions } : unsupported();
    case 'complete':
      return { kind: 'complete' };
    default:
      return unsupported();
  }
}

// undefined: no login is open for the network (the page shows its row).
export function getTrukiLoginView(
  attempt: TrukiLoginAttempt | undefined,
  processes: TrukiBridgeStateType['loginProcesses']
): TrukiLoginView | undefined {
  if (!attempt) {
    return undefined;
  }
  if (attempt.error) {
    return { kind: 'error', error: attempt.error };
  }
  if (attempt.stage === 'flows') {
    return attempt.flows
      ? { kind: 'choose-flow', flows: attempt.flows }
      : { kind: 'waiting', instructions: '' };
  }
  if (attempt.stage !== 'process' || !attempt.processId) {
    return { kind: 'waiting', instructions: '' };
  }
  const process = processes[attempt.processId];
  if (!process) {
    return { kind: 'waiting', instructions: '' };
  }
  if (process.error) {
    return { kind: 'error', error: process.error };
  }
  return parseTrukiLoginStep(process.step);
}

// The ban-risk warning is shown before the first connect per network.
export function trukiNeedsBanRiskDialog(
  accepted: ReadonlyArray<string> | undefined,
  network: string
): boolean {
  return !(accepted ?? []).includes(network);
}

export function trukiWithBanRiskAccepted(
  accepted: ReadonlyArray<string> | undefined,
  network: string
): ReadonlyArray<string> {
  const list = accepted ?? [];
  return list.includes(network) ? list : [...list, network];
}

// The networks the bridge build serves, for when the bridge is not running
// and networks.list cannot be asked (truki-bridge/internal/networks).
export const TRUKI_KNOWN_NETWORKS: ReadonlyArray<{ id: string; name: string }> =
  [
    { id: 'whatsapp', name: 'WhatsApp' },
    { id: 'meta', name: 'Facebook Messenger' },
    { id: 'instagram', name: 'Instagram' },
  ];

// The bridge's own list when it has one; the known networks otherwise.
export function getTrukiPageNetworks(
  networks: ReadonlyArray<{ id: string; name: string }>
): ReadonlyArray<{ id: string; name: string }> {
  return networks.length > 0 ? networks : TRUKI_KNOWN_NETWORKS;
}
