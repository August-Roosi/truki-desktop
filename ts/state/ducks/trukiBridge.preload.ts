// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Bridged chats (WhatsApp, Messenger, ...) as the renderer shows them. The
// bridge is the source of truth; this only holds what is on screen, fed by
// truki-bridge requests and pushed events. See
// docs/truki/specs/2026-10-21-truki-inbox-design.md §3.2 and
// truki-bridge/PROTOCOL.md for the wire shapes parsed here.

import type { ReadonlyDeep } from 'type-fest';
import type { ThunkAction } from 'redux-thunk';
import type { StateType as RootStateType } from '../reducer.preload.ts';
import type { BoundActionCreatorsMapObject } from '../../hooks/useBoundActions.std.ts';
import { useBoundActions } from '../../hooks/useBoundActions.std.ts';
import type {
  TrukiBridgeEvent,
  TrukiBridgeIpcResult,
  TrukiCookieLoginParams,
  TrukiSupervisorStateName,
} from '../../../app/truki/trukiBridgeProtocol.std.ts';
import {
  onTrukiBridgeEvent,
  trukiBridgeGetState,
  trukiBridgeRestart,
  trukiBridgeRequest,
  trukiCookieLogin,
  trukiSetEnabledNetworks,
} from '../../services/trukiBridgeClient.preload.ts';
import { handleTrukiBridgeNotifyFromDuck } from '../../services/trukiBridgeNotifications.preload.ts';
import { actions as conversationsActions } from './conversations.preload.ts';

// State

export type TrukiBridgedChatSummary = ReadonlyDeep<{
  id: string;
  network: string;
  loginId: string;
  name: string;
  avatarMxc?: string;
  isDM: boolean;
  unreadCount: number;
  mutedUntil?: number;
  lastActivity: number;
  lastEventId?: string;
  preview?: { text: string; fromMe: boolean };
}>;

export type TrukiBridgedEvent = ReadonlyDeep<{
  id: string;
  chatId: string;
  sender: string;
  type: string;
  content: unknown;
  timestamp: number;
  streamOrder: number;
  status: '' | 'pending' | 'sent' | 'failed';
  errorCode?: string;
  redacted: boolean;
  relatesTo?: string;
  relType?: string;
}>;

export type TrukiBridgeLoginError = ReadonlyDeep<{
  code: string;
  message: string;
}>;

export type TrukiLoginFlow = ReadonlyDeep<{
  id: string;
  name: string;
  description: string;
}>;

// A login the Connected accounts page has open for a network: the network
// is being enabled (the bridge starting), a flow is being chosen, or a login
// process runs (its step lives in loginProcesses[processId]).
export type TrukiLoginAttempt = ReadonlyDeep<{
  stage: 'starting-bridge' | 'flows' | 'process';
  flows?: ReadonlyArray<TrukiLoginFlow>;
  flowId?: string;
  processId?: string;
  // A request for this login is in flight.
  busy?: boolean;
  error?: TrukiBridgeLoginError;
}>;

export type TrukiBridgeStateType = ReadonlyDeep<{
  bridgeState: TrukiSupervisorStateName;
  networks: ReadonlyArray<{ id: string; name: string; enabled: boolean }>;
  accounts: ReadonlyArray<{
    loginId: string;
    network: string;
    remoteName: string;
    state: string;
    reason?: string;
  }>;
  chats: Readonly<Record<string, TrukiBridgedChatSummary>>;
  selectedChatId: string | undefined;
  messagesByChat: Readonly<
    Record<
      string,
      {
        events: ReadonlyArray<TrukiBridgedEvent>;
        hasOlder: boolean;
        loading: boolean;
        // Ids pushed by event.message while a load was in flight; they are
        // newer than the page that load returns.
        receivedWhileLoading?: ReadonlyArray<string>;
      }
    >
  >;
  loginProcesses: Readonly<
    Record<
      string,
      {
        network: string;
        step: unknown;
        seq: number;
        error?: TrukiBridgeLoginError;
      }
    >
  >;
  pendingLoginEvents: Readonly<
    Record<
      string,
      ReadonlyArray<{
        seq: number;
        step?: unknown;
        error?: TrukiBridgeLoginError;
      }>
    >
  >;
  // Users typing per chat (event.typing sends the full set).
  typingByChat: Readonly<Record<string, ReadonlyArray<string>>>;
  // The last failed request, for the UI to show as a toast.
  lastError: { code: string; message: string; at: number } | undefined;
  // Failed events the user already retried, per chat; Retry is offered once.
  retriedByChat?: Readonly<Record<string, ReadonlyArray<string>>>;
  // Open logins per network (Connected accounts page).
  loginAttempts?: Readonly<Record<string, TrukiLoginAttempt>>;
}>;

type MessagesEntry = ReadonlyDeep<
  TrukiBridgeStateType['messagesByChat'][string]
>;
type AccountRow = ReadonlyDeep<TrukiBridgeStateType['accounts'][number]>;
type PendingLoginEvent = ReadonlyDeep<
  TrukiBridgeStateType['pendingLoginEvents'][string][number]
>;

// The single local Matrix user of the bridge; its events are outgoing.
export const TRUKI_BRIDGE_LOCAL_USER = '@me:truki.local';

const MESSAGES_PAGE_SIZE = 50;
const CHATS_PAGE_SIZE = 200;
const MAX_CHATS = 5000;
const MAX_PENDING_LOGIN_EVENTS = 16;

// Actions

const EVENT_APPLIED = 'trukiBridge/EVENT_APPLIED';
const NETWORKS_LOADED = 'trukiBridge/NETWORKS_LOADED';
const ACCOUNTS_LOADED = 'trukiBridge/ACCOUNTS_LOADED';
const CHATS_LOADED = 'trukiBridge/CHATS_LOADED';
const CHAT_LOADED = 'trukiBridge/CHAT_LOADED';
const CHAT_SELECTED = 'trukiBridge/CHAT_SELECTED';
const SELECTION_CLEARED = 'trukiBridge/SELECTION_CLEARED';
const MESSAGES_LOADING = 'trukiBridge/MESSAGES_LOADING';
const MESSAGES_LOADED = 'trukiBridge/MESSAGES_LOADED';
const MESSAGES_LOAD_FAILED = 'trukiBridge/MESSAGES_LOAD_FAILED';
const LOGIN_STARTED = 'trukiBridge/LOGIN_STARTED';
const ERROR_SET = 'trukiBridge/ERROR_SET';
const ERROR_CLEARED = 'trukiBridge/ERROR_CLEARED';
const RETRY_STARTED = 'trukiBridge/RETRY_STARTED';
const RETRY_FAILED = 'trukiBridge/RETRY_FAILED';
const LOGIN_ATTEMPT_SET = 'trukiBridge/LOGIN_ATTEMPT_SET';
const LOGIN_ATTEMPT_PATCHED = 'trukiBridge/LOGIN_ATTEMPT_PATCHED';

type EventAppliedAction = ReadonlyDeep<{
  type: typeof EVENT_APPLIED;
  payload: { event: TrukiBridgeEvent; receivedAt: number };
}>;
type NetworksLoadedAction = ReadonlyDeep<{
  type: typeof NETWORKS_LOADED;
  payload: TrukiBridgeStateType['networks'];
}>;
type AccountsLoadedAction = ReadonlyDeep<{
  type: typeof ACCOUNTS_LOADED;
  payload: TrukiBridgeStateType['accounts'];
}>;
type ChatsLoadedAction = ReadonlyDeep<{
  type: typeof CHATS_LOADED;
  payload: ReadonlyArray<unknown>;
}>;
type ChatLoadedAction = ReadonlyDeep<{
  type: typeof CHAT_LOADED;
  payload: unknown;
}>;
type ChatSelectedAction = ReadonlyDeep<{
  type: typeof CHAT_SELECTED;
  payload: { chatId: string };
}>;
type SelectionClearedAction = ReadonlyDeep<{ type: typeof SELECTION_CLEARED }>;
type MessagesLoadingAction = ReadonlyDeep<{
  type: typeof MESSAGES_LOADING;
  payload: { chatId: string };
}>;
type MessagesLoadedAction = ReadonlyDeep<{
  type: typeof MESSAGES_LOADED;
  payload: {
    chatId: string;
    events: ReadonlyArray<unknown>;
    mode: 'replace' | 'older';
    hasOlder: boolean;
  };
}>;
type MessagesLoadFailedAction = ReadonlyDeep<{
  type: typeof MESSAGES_LOAD_FAILED;
  payload: { chatId: string };
}>;
type LoginStartedAction = ReadonlyDeep<{
  type: typeof LOGIN_STARTED;
  payload: { processId: string; network: string; step: unknown; seq: number };
}>;
type ErrorSetAction = ReadonlyDeep<{
  type: typeof ERROR_SET;
  payload: { code: string; message: string; at: number };
}>;
type ErrorClearedAction = ReadonlyDeep<{ type: typeof ERROR_CLEARED }>;
type RetryAction = ReadonlyDeep<{
  type: typeof RETRY_STARTED | typeof RETRY_FAILED;
  payload: { chatId: string; eventId: string };
}>;

// Replaces (or with no attempt, closes) a network's login; the process of the
// attempt it replaces is forgotten.
type LoginAttemptSetAction = ReadonlyDeep<{
  type: typeof LOGIN_ATTEMPT_SET;
  payload: { network: string; attempt: TrukiLoginAttempt | undefined };
}>;
// Merged into the network's attempt; nothing happens when it was closed.
type LoginAttemptPatchedAction = ReadonlyDeep<{
  type: typeof LOGIN_ATTEMPT_PATCHED;
  payload: { network: string; patch: Partial<TrukiLoginAttempt> };
}>;

export type TrukiBridgeAction = ReadonlyDeep<
  | EventAppliedAction
  | NetworksLoadedAction
  | AccountsLoadedAction
  | ChatsLoadedAction
  | ChatLoadedAction
  | ChatSelectedAction
  | SelectionClearedAction
  | MessagesLoadingAction
  | MessagesLoadedAction
  | MessagesLoadFailedAction
  | LoginStartedAction
  | ErrorSetAction
  | ErrorClearedAction
  | RetryAction
  | LoginAttemptSetAction
  | LoginAttemptPatchedAction
>;

type TrukiBridgeThunk<R = void> = ReadonlyDeep<
  ThunkAction<R, RootStateType, unknown, TrukiBridgeAction>
>;

// Client seam (tests swap it for a fake)

export type TrukiBridgeClient = ReadonlyDeep<{
  request: <T>(
    method: string,
    params?: unknown
  ) => Promise<TrukiBridgeIpcResult<T>>;
  getState: () => Promise<TrukiBridgeIpcResult<TrukiSupervisorStateName>>;
  restart: () => Promise<TrukiBridgeIpcResult<void>>;
  onEvent: (cb: (e: TrukiBridgeEvent) => void) => () => void;
  setEnabledNetworks?: (
    ids: ReadonlyArray<string>
  ) => Promise<TrukiBridgeIpcResult<void>>;
  cookieLogin?: (
    params: TrukiCookieLoginParams
  ) => Promise<
    TrukiBridgeIpcResult<{ cancelled: true } | { step: unknown; seq: number }>
  >;
}>;

const defaultClient: TrukiBridgeClient = {
  request: trukiBridgeRequest,
  getState: trukiBridgeGetState,
  restart: trukiBridgeRestart,
  onEvent: onTrukiBridgeEvent,
  setEnabledNetworks: trukiSetEnabledNetworks,
  cookieLogin: trukiCookieLogin,
};

const NOT_SUPPORTED: TrukiBridgeIpcResult<never> = {
  ok: false,
  code: 'INTERNAL',
  message: 'not supported by this client',
};

let client: TrukiBridgeClient = defaultClient;
let unsubscribe: (() => void) | undefined;
const chatsBeingFetched = new Set<string>();

export function setTrukiBridgeClientForTesting(
  testClient: TrukiBridgeClient | undefined
): void {
  unsubscribe?.();
  unsubscribe = undefined;
  chatsBeingFetched.clear();
  client = testClient ?? defaultClient;
}

// Wire parsing. Params come from the bridge through main; anything that does
// not have the documented shape is ignored rather than trusted.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

const SUPERVISOR_STATES: ReadonlySet<string> =
  new Set<TrukiSupervisorStateName>([
    'stopped',
    'starting',
    'running',
    'backoff',
    'gave-up',
    'unavailable',
  ]);

function parseSupervisorState(
  value: unknown
): TrukiSupervisorStateName | undefined {
  return typeof value === 'string' && SUPERVISOR_STATES.has(value)
    ? (value as TrukiSupervisorStateName)
    : undefined;
}

function parseChat(
  value: unknown,
  existing: TrukiBridgedChatSummary | undefined
): TrukiBridgedChatSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = str(value.id);
  if (!id) {
    return undefined;
  }
  const avatarMxc = str(value.avatar) || undefined;
  const mutedUntil = parseTime(value.mutedUntil);
  const lastEventId = str(value.lastEventId) || existing?.lastEventId;
  return {
    id,
    network: str(value.network) ?? '',
    loginId: str(value.loginId) ?? '',
    name: str(value.name) ?? '',
    isDM: value.isDm === true,
    unreadCount:
      typeof value.unreadCount === 'number' && value.unreadCount >= 0
        ? value.unreadCount
        : 0,
    lastActivity: parseTime(value.lastActivity) ?? existing?.lastActivity ?? 0,
    ...(avatarMxc ? { avatarMxc } : {}),
    ...(mutedUntil !== undefined ? { mutedUntil } : {}),
    ...(lastEventId ? { lastEventId } : {}),
    ...(existing?.preview ? { preview: existing.preview } : {}),
  };
}

function stripRedacted(content: unknown): unknown {
  if (isRecord(content) && content['m.relates_to'] !== undefined) {
    return { 'm.relates_to': content['m.relates_to'] };
  }
  return {};
}

function parseStatus(value: unknown): TrukiBridgedEvent['status'] {
  return value === 'pending' || value === 'sent' || value === 'failed'
    ? value
    : '';
}

function parseEvent(
  value: unknown,
  fallbackTime: number
): TrukiBridgedEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = str(value.id);
  const chatId = str(value.chatId);
  if (!id || !chatId) {
    return undefined;
  }
  const redacted = value.redacted === true;
  const errorCode = str(value.errorCode);
  const relatesTo = str(value.relatesTo);
  const relType = str(value.relType);
  return {
    id,
    chatId,
    sender: str(value.sender) ?? '',
    type: str(value.type) ?? '',
    content: redacted ? stripRedacted(value.content) : (value.content ?? {}),
    timestamp: parseTime(value.timestamp) ?? fallbackTime,
    streamOrder: typeof value.streamOrder === 'number' ? value.streamOrder : 0,
    status: parseStatus(value.status),
    redacted,
    ...(errorCode ? { errorCode } : {}),
    ...(relatesTo ? { relatesTo } : {}),
    ...(relType ? { relType } : {}),
  };
}

function parseLoginError(value: unknown): TrukiBridgeLoginError | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    code: str(value.code) ?? 'LOGIN_FAILED',
    message: str(value.message) ?? '',
  };
}

function isFromMe(event: TrukiBridgedEvent): boolean {
  return event.sender === TRUKI_BRIDGE_LOCAL_USER || event.status !== '';
}

// A visible message in the timeline (not a reaction, edit or redaction).
function isTimelineMessage(event: TrukiBridgedEvent): boolean {
  return event.type === 'm.room.message' && event.relType !== 'm.replace';
}

function previewText(event: TrukiBridgedEvent): string {
  if (event.redacted || !isRecord(event.content)) {
    return '';
  }
  return str(event.content.body) ?? '';
}

// Action creators (plain)

export function trukiBridgeEventApplied(
  event: TrukiBridgeEvent,
  receivedAt: number
): EventAppliedAction {
  return { type: EVENT_APPLIED, payload: { event, receivedAt } };
}

export function messagesLoaded(
  chatId: string,
  events: ReadonlyArray<unknown>,
  mode: 'replace' | 'older',
  hasOlder: boolean
): MessagesLoadedAction {
  return {
    type: MESSAGES_LOADED,
    payload: { chatId, events, mode, hasOlder },
  };
}

export function messagesLoading(chatId: string): MessagesLoadingAction {
  return { type: MESSAGES_LOADING, payload: { chatId } };
}

export function loginStarted(payload: {
  processId: string;
  network: string;
  step: unknown;
  seq: number;
}): LoginStartedAction {
  return { type: LOGIN_STARTED, payload };
}

function clearBridgedSelection(): SelectionClearedAction {
  return { type: SELECTION_CLEARED };
}

function clearBridgeError(): ErrorClearedAction {
  return { type: ERROR_CLEARED };
}

function errorFrom(
  result: TrukiBridgeIpcResult<unknown> & { ok: false }
): ErrorSetAction {
  return {
    type: ERROR_SET,
    payload: {
      code: result.bridgeCode ?? result.code,
      message: result.message,
      at: Date.now(),
    },
  };
}

// Thunks. None of them throws: a failed request becomes `lastError`.

async function call<T>(
  dispatch: (action: TrukiBridgeAction) => unknown,
  method: string,
  params?: unknown
): Promise<T | undefined> {
  const result = await client.request<T>(method, params);
  if (!result.ok) {
    dispatch(errorFrom(result));
    return undefined;
  }
  return result.value;
}

// The "Bridges stopped" banner's Restart. The new state arrives as
// event.supervisorState; only a refusal is reported here.
function restartBridge(): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    const result = await client.restart();
    if (!result.ok) {
      dispatch(errorFrom(result));
    }
  };
}

function loadNetworksAndAccounts(): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    const networks = await call<unknown>(dispatch, 'networks.list');
    if (Array.isArray(networks)) {
      dispatch({
        type: NETWORKS_LOADED,
        payload: networks.filter(isRecord).map(n => ({
          id: str(n.id) ?? '',
          name: str(n.name) ?? '',
          enabled: n.enabled === true,
        })),
      });
    }
    const accounts = await call<unknown>(dispatch, 'accounts.list');
    if (Array.isArray(accounts)) {
      dispatch({
        type: ACCOUNTS_LOADED,
        payload: accounts.filter(isRecord).map(a => {
          const row: AccountRow = {
            loginId: str(a.loginId) ?? '',
            network: str(a.network) ?? '',
            remoteName: str(a.remoteName) ?? '',
            state: str(a.state) ?? 'UNKNOWN',
          };
          const reason = str(a.reason);
          return reason ? { ...row, reason } : row;
        }),
      });
    }
  };
}

function loadChats(): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    const all: Array<unknown> = [];
    let cursor: string | undefined;
    while (all.length < MAX_CHATS) {
      // Pages are sequential: each needs the previous page's cursor.
      // oxlint-disable-next-line no-await-in-loop
      const page = await call<unknown>(
        dispatch,
        'chats.list',
        cursor ? { cursor, limit: CHATS_PAGE_SIZE } : { limit: CHATS_PAGE_SIZE }
      );
      if (!isRecord(page)) {
        return;
      }
      const chats = Array.isArray(page.chats) ? page.chats : [];
      all.push(...chats);
      cursor = str(page.nextCursor);
      if (!cursor || chats.length === 0) {
        break;
      }
    }
    dispatch({ type: CHATS_LOADED, payload: all.slice(0, MAX_CHATS) });
  };
}

function fetchChat(chatId: string): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    if (chatsBeingFetched.has(chatId)) {
      return;
    }
    chatsBeingFetched.add(chatId);
    try {
      const result = await call<unknown>(dispatch, 'chats.get', { chatId });
      if (isRecord(result)) {
        dispatch({ type: CHAT_LOADED, payload: result.chat });
      }
    } finally {
      chatsBeingFetched.delete(chatId);
    }
  };
}

function loadMessages(
  chatId: string,
  mode: 'replace' | 'older'
): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const entry = getState().trukiBridge.messagesByChat[chatId];
    if (entry?.loading) {
      return;
    }
    let before: number | undefined;
    if (mode === 'older') {
      if (!entry || !entry.hasOlder || entry.events.length === 0) {
        return;
      }
      before = entry.events[0]?.streamOrder;
    }
    dispatch(messagesLoading(chatId));
    const result = await call<unknown>(dispatch, 'messages.list', {
      chatId,
      limit: MESSAGES_PAGE_SIZE,
      ...(before !== undefined ? { before } : {}),
    });
    if (!isRecord(result) || !Array.isArray(result.events)) {
      dispatch({ type: MESSAGES_LOAD_FAILED, payload: { chatId } });
      return;
    }
    dispatch(
      messagesLoaded(
        chatId,
        result.events,
        mode,
        result.events.length >= MESSAGES_PAGE_SIZE
      )
    );
  };
}

function loadOlderMessages(chatId: string): TrukiBridgeThunk<Promise<void>> {
  return loadMessages(chatId, 'older');
}

function reloadAfterStart(): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const { selectedChatId } = getState().trukiBridge;
    await Promise.all([
      dispatch(loadNetworksAndAccounts()),
      dispatch(loadChats()),
      selectedChatId
        ? dispatch(loadMessages(selectedChatId, 'replace'))
        : undefined,
    ]);
  };
}

function trukiBridgeEventReceived(event: TrukiBridgeEvent): TrukiBridgeThunk {
  return (dispatch, getState) => {
    const before = getState().trukiBridge;
    dispatch(trukiBridgeEventApplied(event, Date.now()));

    const { method, params } = event;
    if (method === 'event.supervisorState' && isRecord(params)) {
      const next = parseSupervisorState(params.state);
      if (next === 'running' && before.bridgeState !== 'running') {
        void dispatch(reloadAfterStart());
        for (const [network, attempt] of Object.entries(
          getState().trukiBridge.loginAttempts ?? {}
        )) {
          if (attempt.stage === 'starting-bridge' && !attempt.error) {
            void dispatch(loadLoginFlows(network));
          }
        }
      }
      return;
    }
    if (
      method === 'event.login.step' &&
      isRecord(params) &&
      isCompleteStep(params.step)
    ) {
      void dispatch(loadNetworksAndAccounts());
      return;
    }
    if (method === 'event.message' && isRecord(params)) {
      const chatId = str(params.chatId);
      if (chatId && !before.chats[chatId]) {
        void dispatch(fetchChat(chatId));
      }
    }
    if (method === 'event.notify' && isRecord(params)) {
      const chatId = str(params.chatId);
      // Without a chatId there is no chat to mute, focus or select.
      if (chatId) {
        handleTrukiBridgeNotifyFromDuck(
          {
            chatId,
            senderName:
              str(params.senderName) || before.chats[chatId]?.name || '',
            preview: str(params.message) || '',
            network: str(params.network) || '',
          },
          {
            getState,
            showConversation: options =>
              dispatch(conversationsActions.showConversation(options)),
            selectBridgedChat: id => dispatch(actions.selectBridgedChat(id)),
          }
        );
      }
      return;
    }
  };
}

function trukiBridgeStart(): TrukiBridgeThunk {
  return dispatch => {
    if (unsubscribe) {
      return;
    }
    unsubscribe = client.onEvent(e => {
      dispatch(trukiBridgeEventReceived(e));
    });
    void (async () => {
      const result = await client.getState();
      if (!result.ok) {
        dispatch(errorFrom(result));
        return;
      }
      // Applying the pulled state as an event also loads everything when
      // the bridge is already running.
      dispatch(
        trukiBridgeEventReceived({
          method: 'event.supervisorState',
          params: { state: result.value },
        })
      );
    })();
  };
}

function selectBridgedChat(chatId: string): TrukiBridgeThunk {
  return (dispatch, getState) => {
    dispatch({ type: CHAT_SELECTED, payload: { chatId } });
    const { bridgeState, messagesByChat } = getState().trukiBridge;
    // While the bridge is down the open chat is loaded when it is running.
    if (bridgeState === 'running' && !messagesByChat[chatId]) {
      void dispatch(loadMessages(chatId, 'replace'));
    }
  };
}

function sendText(
  chatId: string,
  text: string,
  replyTo?: string
): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    await call(dispatch, 'messages.send', {
      chatId,
      text,
      ...(replyTo ? { replyTo } : {}),
    });
  };
}

function sendReaction(
  chatId: string,
  eventId: string,
  key: string
): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    await call(dispatch, 'messages.react', { chatId, eventId, key });
  };
}

function redactMessage(
  chatId: string,
  eventId: string
): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    await call(dispatch, 'messages.redact', { chatId, eventId });
  };
}

function markRead(
  chatId: string,
  eventId: string
): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    await call(dispatch, 'chats.markRead', { chatId, eventId });
  };
}

// `until` is a ms timestamp; undefined unmutes.
function setMuted(
  chatId: string,
  until: number | undefined
): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    await call(dispatch, 'chats.setMuted', {
      chatId,
      ...(until !== undefined ? { until: new Date(until).toISOString() } : {}),
    });
  };
}

// A new send with the failed event's text and reply; never automatic, and
// once per failed event (a second Retry while or after it is sent does
// nothing). A send the bridge refused can be retried again.
function retrySend(
  chatId: string,
  eventId: string
): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const { trukiBridge } = getState();
    if (trukiBridge.retriedByChat?.[chatId]?.includes(eventId)) {
      return;
    }
    const event = trukiBridge.messagesByChat[chatId]?.events.find(
      e => e.id === eventId
    );
    const content = event && isRecord(event.content) ? event.content : {};
    const text = str(content.body);
    if (!event || content.msgtype !== 'm.text' || text === undefined) {
      dispatch({
        type: ERROR_SET,
        payload: {
          code: 'INVALID_INPUT',
          message: 'only failed text messages can be retried',
          at: Date.now(),
        },
      });
      return;
    }
    const relatesTo = content['m.relates_to'];
    const inReplyTo = isRecord(relatesTo)
      ? relatesTo['m.in_reply_to']
      : undefined;
    const replyTo = isRecord(inReplyTo) ? str(inReplyTo.event_id) : undefined;
    dispatch({ type: RETRY_STARTED, payload: { chatId, eventId } });
    const result = await call(dispatch, 'messages.send', {
      chatId,
      text,
      ...(replyTo ? { replyTo } : {}),
    });
    if (result === undefined) {
      dispatch({ type: RETRY_FAILED, payload: { chatId, eventId } });
    }
  };
}

// Logins (Connected accounts page). None of these throws; a failure becomes
// the attempt's error, which the page shows with Try again.

function loginErrorFrom(
  result: TrukiBridgeIpcResult<unknown> & { ok: false }
): TrukiBridgeLoginError {
  return { code: result.bridgeCode ?? result.code, message: result.message };
}

function setLoginAttempt(
  network: string,
  attempt: TrukiLoginAttempt | undefined
): LoginAttemptSetAction {
  return { type: LOGIN_ATTEMPT_SET, payload: { network, attempt } };
}

function patchLoginAttempt(
  network: string,
  patch: Partial<TrukiLoginAttempt>
): LoginAttemptPatchedAction {
  return { type: LOGIN_ATTEMPT_PATCHED, payload: { network, patch } };
}

function parseFlows(value: unknown): ReadonlyArray<TrukiLoginFlow> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map(f => ({
      id: str(f.id) ?? '',
      name: str(f.name) ?? '',
      description: str(f.description) ?? '',
    }))
    .filter(f => f.id !== '');
}

function isCompleteStep(step: unknown): boolean {
  return isRecord(step) && step.type === 'complete';
}

// The attempt's running process and its current step id, if it has one.
function currentLoginStep(
  state: TrukiBridgeStateType,
  network: string
): { processId: string; stepId: string } | undefined {
  const processId = state.loginAttempts?.[network]?.processId;
  const process = processId ? state.loginProcesses[processId] : undefined;
  if (!processId || !process || process.error || !isRecord(process.step)) {
    return undefined;
  }
  const stepId = str(process.step.step_id);
  return stepId ? { processId, stepId } : undefined;
}

function loadLoginFlows(network: string): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const result = await client.request<unknown>('login.flows', { network });
    if (!getState().trukiBridge.loginAttempts?.[network]) {
      return;
    }
    if (!result.ok) {
      dispatch(patchLoginAttempt(network, { error: loginErrorFrom(result) }));
      return;
    }
    const flows = parseFlows(result.value);
    const [only] = flows;
    if (flows.length === 1 && only) {
      await dispatch(startLogin(network, only.id));
      return;
    }
    dispatch(patchLoginAttempt(network, { stage: 'flows', flows }));
  };
}

// Connect: enables the network (main starts the bridge if needed), keeping
// every network that already has logins enabled, then opens its login.
function enableNetwork(network: string): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    dispatch(setLoginAttempt(network, { stage: 'starting-bridge' }));
    let { networks } = getState().trukiBridge;
    if (getState().trukiBridge.bridgeState === 'running') {
      const fresh = await client.request<unknown>('networks.list');
      if (fresh.ok && Array.isArray(fresh.value)) {
        networks = fresh.value.filter(isRecord).map(n => ({
          id: str(n.id) ?? '',
          name: str(n.name) ?? '',
          enabled: n.enabled === true,
        }));
        dispatch({ type: NETWORKS_LOADED, payload: networks });
      }
    }
    const enabled = networks.filter(n => n.enabled).map(n => n.id);
    const ids = enabled.includes(network) ? enabled : [...enabled, network];
    const result = await (client.setEnabledNetworks?.(ids) ?? NOT_SUPPORTED);
    if (!getState().trukiBridge.loginAttempts?.[network]) {
      return;
    }
    if (!result.ok) {
      dispatch(patchLoginAttempt(network, { error: loginErrorFrom(result) }));
      return;
    }
    // Otherwise the bridge is starting; event.supervisorState 'running'
    // loads the flows.
    if (getState().trukiBridge.bridgeState === 'running') {
      await dispatch(loadLoginFlows(network));
    }
  };
}

function startLogin(
  network: string,
  flowId: string
): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const flows = getState().trukiBridge.loginAttempts?.[network]?.flows;
    dispatch(
      setLoginAttempt(network, {
        stage: 'process',
        flowId,
        busy: true,
        ...(flows ? { flows } : {}),
      })
    );
    const result = await client.request<unknown>('login.start', {
      network,
      flowId,
    });
    const value = result.ok && isRecord(result.value) ? result.value : {};
    const processId = str(value.processId);
    if (!getState().trukiBridge.loginAttempts?.[network]) {
      // Cancelled while starting: close the process the bridge just opened.
      if (processId) {
        void client.request('login.cancel', { processId });
      }
      return;
    }
    if (!result.ok) {
      dispatch(
        patchLoginAttempt(network, {
          busy: false,
          error: loginErrorFrom(result),
        })
      );
      return;
    }
    if (!processId) {
      dispatch(
        patchLoginAttempt(network, {
          busy: false,
          error: { code: 'INTERNAL', message: 'no login process' },
        })
      );
      return;
    }
    dispatch(
      loginStarted({
        processId,
        network,
        step: value.step,
        seq: typeof value.seq === 'number' ? value.seq : 0,
      })
    );
    if (isCompleteStep(value.step)) {
      await dispatch(loadNetworksAndAccounts());
    }
  };
}

// Try again after an error: the same flow again, or the flows from the start.
function retryLogin(network: string): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const flowId = getState().trukiBridge.loginAttempts?.[network]?.flowId;
    await dispatch(
      flowId ? startLogin(network, flowId) : enableNetwork(network)
    );
  };
}

// A submit result is the next step, applied like event.login.step.
function applyLoginResult(
  network: string,
  processId: string,
  value: unknown
): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    dispatch(patchLoginAttempt(network, { busy: false }));
    const params = isRecord(value) ? value : {};
    dispatch(
      trukiBridgeEventReceived({
        method: 'event.login.step',
        params: { processId, step: params.step, seq: params.seq },
      })
    );
  };
}

function submitLoginInput(
  network: string,
  input: Readonly<Record<string, string>>
): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const current = currentLoginStep(getState().trukiBridge, network);
    if (!current) {
      return;
    }
    dispatch(patchLoginAttempt(network, { busy: true }));
    const result = await client.request<unknown>('login.submit', {
      ...current,
      input,
    });
    if (!result.ok) {
      dispatch(
        patchLoginAttempt(network, {
          busy: false,
          error: loginErrorFrom(result),
        })
      );
      return;
    }
    await dispatch(applyLoginResult(network, current.processId, result.value));
  };
}

// A cookies step: main opens the network's login page in its own window and
// submits the cookies; this only sees the next step, a cancel or an error.
function startCookieLogin(network: string): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const current = currentLoginStep(getState().trukiBridge, network);
    if (!current) {
      return;
    }
    dispatch(patchLoginAttempt(network, { busy: true }));
    const result = await (client.cookieLogin?.(current) ?? NOT_SUPPORTED);
    if (!result.ok) {
      dispatch(
        patchLoginAttempt(network, {
          busy: false,
          error: loginErrorFrom(result),
        })
      );
      return;
    }
    if ('cancelled' in result.value) {
      dispatch(patchLoginAttempt(network, { busy: false }));
      return;
    }
    await dispatch(applyLoginResult(network, current.processId, result.value));
  };
}

// Closes the network's login; a running process is cancelled.
function cancelLogin(network: string): TrukiBridgeThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const state = getState().trukiBridge;
    const attempt = state.loginAttempts?.[network];
    if (!attempt) {
      return;
    }
    const { processId } = attempt;
    const process = processId ? state.loginProcesses[processId] : undefined;
    dispatch(setLoginAttempt(network, undefined));
    if (processId && process && !process.error && !attempt.error) {
      // NOT_FOUND (the bridge already closed it) is not worth showing.
      await client.request('login.cancel', { processId });
    }
  };
}

function logout(
  network: string,
  loginId: string
): TrukiBridgeThunk<Promise<void>> {
  return async dispatch => {
    await call(dispatch, 'accounts.logout', { loginId, network });
    await dispatch(loadNetworksAndAccounts());
  };
}

export const actions = {
  trukiBridgeStart,
  restartBridge,
  trukiBridgeEventReceived,
  loadChats,
  selectBridgedChat,
  clearBridgedSelection,
  loadOlderMessages,
  sendText,
  sendReaction,
  redactMessage,
  markRead,
  setMuted,
  retrySend,
  clearBridgeError,
  enableNetwork,
  startLogin,
  retryLogin,
  submitLoginInput,
  startCookieLogin,
  cancelLogin,
  logout,
};

export const useTrukiBridgeActions = (): BoundActionCreatorsMapObject<
  typeof actions
> => useBoundActions(actions);

// Reducer

export function getEmptyState(): TrukiBridgeStateType {
  return {
    bridgeState: 'stopped',
    networks: [],
    accounts: [],
    chats: {},
    selectedChatId: undefined,
    messagesByChat: {},
    loginProcesses: {},
    pendingLoginEvents: {},
    typingByChat: {},
    lastError: undefined,
  };
}

function upsertEvents(
  existing: ReadonlyArray<TrukiBridgedEvent>,
  incoming: ReadonlyArray<TrukiBridgedEvent>
): ReadonlyArray<TrukiBridgedEvent> {
  const byId = new Map<string, TrukiBridgedEvent>();
  for (const event of existing) {
    byId.set(event.id, event);
  }
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => a.streamOrder - b.streamOrder);
}

function applyMessage(
  state: TrukiBridgeStateType,
  event: TrukiBridgedEvent
): TrukiBridgeStateType {
  const { chatId } = event;
  const entry = state.messagesByChat[chatId];
  const known = entry?.events.some(e => e.id === event.id) ?? false;
  const existingChat = state.chats[chatId];
  const chat: TrukiBridgedChatSummary = existingChat ?? {
    id: chatId,
    network: '',
    loginId: '',
    name: '',
    isDM: false,
    unreadCount: 0,
    lastActivity: 0,
  };

  let nextChat = chat;
  if (isTimelineMessage(event)) {
    const fromMe = isFromMe(event);
    const isNew = !known && chat.lastEventId !== event.id;
    if (event.timestamp >= chat.lastActivity || chat.lastEventId === event.id) {
      nextChat = {
        ...nextChat,
        lastActivity: Math.max(event.timestamp, chat.lastActivity),
        lastEventId: event.id,
        preview: { text: previewText(event), fromMe },
      };
    }
    if (isNew && !fromMe && !event.redacted) {
      nextChat = { ...nextChat, unreadCount: nextChat.unreadCount + 1 };
    }
  } else if (event.redacted && chat.lastEventId === event.id && chat.preview) {
    nextChat = { ...nextChat, preview: { ...chat.preview, text: '' } };
  }

  return {
    ...state,
    chats:
      nextChat === existingChat
        ? state.chats
        : { ...state.chats, [chatId]: nextChat },
    messagesByChat: entry
      ? {
          ...state.messagesByChat,
          [chatId]: {
            ...entry,
            events: upsertEvents(entry.events, [event]),
            ...(entry.loading
              ? {
                  receivedWhileLoading: [
                    ...(entry.receivedWhileLoading ?? []),
                    event.id,
                  ],
                }
              : {}),
          },
        }
      : state.messagesByChat,
  };
}

function applyLoginEvent(
  process: TrukiBridgeStateType['loginProcesses'][string],
  pending: PendingLoginEvent
): TrukiBridgeStateType['loginProcesses'][string] {
  if (pending.error) {
    return { ...process, error: pending.error };
  }
  if (pending.seq > process.seq) {
    return {
      ...process,
      step: pending.step,
      seq: pending.seq,
      error: undefined,
    };
  }
  return process;
}

function applyLoginStep(
  state: TrukiBridgeStateType,
  params: Record<string, unknown>
): TrukiBridgeStateType {
  const processId = str(params.processId);
  if (!processId) {
    return state;
  }
  const error = parseLoginError(params.error);
  const seq = typeof params.seq === 'number' ? params.seq : 0;
  const pending: PendingLoginEvent = error
    ? { seq, error }
    : { seq, step: params.step };

  const process = state.loginProcesses[processId];
  if (process) {
    const next = applyLoginEvent(process, pending);
    return next === process
      ? state
      : {
          ...state,
          loginProcesses: { ...state.loginProcesses, [processId]: next },
        };
  }
  const buffered = state.pendingLoginEvents[processId] ?? [];
  return {
    ...state,
    pendingLoginEvents: {
      ...state.pendingLoginEvents,
      [processId]: [...buffered, pending].slice(-MAX_PENDING_LOGIN_EVENTS),
    },
  };
}

// A process that reached `complete` closes the login that ran it.
function finishCompletedLogin(
  state: TrukiBridgeStateType,
  processId: string
): TrukiBridgeStateType {
  const process = state.loginProcesses[processId];
  if (!process || process.error || !isCompleteStep(process.step)) {
    return state;
  }
  const entry = Object.entries(state.loginAttempts ?? {}).find(
    ([, attempt]) => attempt.processId === processId
  );
  if (!entry) {
    return state;
  }
  const loginAttempts = { ...state.loginAttempts };
  delete loginAttempts[entry[0]];
  const loginProcesses = { ...state.loginProcesses };
  delete loginProcesses[processId];
  return { ...state, loginAttempts, loginProcesses };
}

function applyAccountState(
  state: TrukiBridgeStateType,
  params: Record<string, unknown>
): TrukiBridgeStateType {
  const loginId = str(params.loginId);
  if (!loginId) {
    return state;
  }
  const network = str(params.network) ?? '';
  const reason = str(params.reason);
  const existing = state.accounts.find(
    a => a.loginId === loginId && a.network === network
  );
  const row: AccountRow = {
    loginId,
    network,
    remoteName: existing?.remoteName ?? '',
    state: str(params.state) ?? 'UNKNOWN',
    ...(reason ? { reason } : {}),
  };
  if (!existing) {
    return { ...state, accounts: [...state.accounts, row] };
  }
  return {
    ...state,
    accounts: state.accounts.map(a => (a === existing ? row : a)),
  };
}

function applySupervisorState(
  state: TrukiBridgeStateType,
  next: TrukiSupervisorStateName
): TrukiBridgeStateType {
  if (next === state.bridgeState) {
    return state;
  }
  const messagesByChat: Record<string, MessagesEntry> = {};
  for (const [chatId, entry] of Object.entries(state.messagesByChat)) {
    if (next === 'running') {
      // Events pushed while the bridge was down were missed: only the open
      // chat is kept (and reloaded by the thunk); others reload when opened.
      if (chatId === state.selectedChatId) {
        messagesByChat[chatId] = { ...entry, loading: false };
      }
    } else {
      messagesByChat[chatId] = { ...entry, loading: false };
    }
  }
  return {
    ...state,
    bridgeState: next,
    messagesByChat,
    typingByChat: next === 'running' ? state.typingByChat : {},
  };
}

function applyEvent(
  state: TrukiBridgeStateType,
  { method, params }: TrukiBridgeEvent,
  receivedAt: number
): TrukiBridgeStateType {
  if (!isRecord(params)) {
    return state;
  }
  switch (method) {
    case 'event.supervisorState': {
      const next = parseSupervisorState(params.state);
      return next ? applySupervisorState(state, next) : state;
    }
    case 'event.message': {
      const event = parseEvent(params, receivedAt);
      return event ? applyMessage(state, event) : state;
    }
    case 'event.chat': {
      const id = str(params.id);
      const chat = parseChat(params, id ? state.chats[id] : undefined);
      return chat
        ? { ...state, chats: { ...state.chats, [chat.id]: chat } }
        : state;
    }
    case 'event.accountState':
      return applyAccountState(state, params);
    case 'event.login.step': {
      const processId = str(params.processId);
      const next = applyLoginStep(state, params);
      return processId ? finishCompletedLogin(next, processId) : next;
    }
    case 'event.typing': {
      const chatId = str(params.chatId);
      if (!chatId) {
        return state;
      }
      const users = Array.isArray(params.users)
        ? params.users.filter((u): u is string => typeof u === 'string')
        : [];
      const typingByChat = { ...state.typingByChat };
      if (users.length) {
        typingByChat[chatId] = users;
      } else {
        delete typingByChat[chatId];
      }
      return { ...state, typingByChat };
    }
    default:
      // event.receipt and event.notify carry nothing this state shows.
      return state;
  }
}

export function reducer(
  state: TrukiBridgeStateType = getEmptyState(),
  action: TrukiBridgeAction
): TrukiBridgeStateType {
  switch (action.type) {
    case EVENT_APPLIED:
      return applyEvent(state, action.payload.event, action.payload.receivedAt);
    case NETWORKS_LOADED:
      return { ...state, networks: action.payload };
    case ACCOUNTS_LOADED:
      return { ...state, accounts: action.payload };
    case CHATS_LOADED: {
      const chats: Record<string, TrukiBridgedChatSummary> = {};
      for (const value of action.payload) {
        const id = isRecord(value) ? str(value.id) : undefined;
        const chat = parseChat(value, id ? state.chats[id] : undefined);
        if (chat) {
          chats[chat.id] = chat;
        }
      }
      return { ...state, chats };
    }
    case CHAT_LOADED: {
      const id = isRecord(action.payload) ? str(action.payload.id) : undefined;
      const chat = parseChat(action.payload, id ? state.chats[id] : undefined);
      return chat
        ? { ...state, chats: { ...state.chats, [chat.id]: chat } }
        : state;
    }
    case CHAT_SELECTED:
      return { ...state, selectedChatId: action.payload.chatId };
    case SELECTION_CLEARED:
      return state.selectedChatId === undefined
        ? state
        : { ...state, selectedChatId: undefined };
    case MESSAGES_LOADING: {
      const { chatId } = action.payload;
      const entry = state.messagesByChat[chatId] ?? {
        events: [],
        hasOlder: false,
        loading: false,
      };
      return {
        ...state,
        messagesByChat: {
          ...state.messagesByChat,
          [chatId]: { ...entry, loading: true, receivedWhileLoading: [] },
        },
      };
    }
    case MESSAGES_LOAD_FAILED: {
      const { chatId } = action.payload;
      const entry = state.messagesByChat[chatId];
      if (!entry) {
        return state;
      }
      return {
        ...state,
        messagesByChat: {
          ...state.messagesByChat,
          [chatId]: { ...entry, loading: false },
        },
      };
    }
    case MESSAGES_LOADED: {
      const { chatId, mode, hasOlder } = action.payload;
      const events: Array<TrukiBridgedEvent> = [];
      for (const value of action.payload.events) {
        const event = parseEvent(value, 0);
        if (event && event.chatId === chatId) {
          events.push(event);
        }
      }
      const entry = state.messagesByChat[chatId];
      // What the store already holds is at least as new as the page, so it
      // wins over the page's copy of the same event. A replace drops older
      // stale events, but keeps those pushed during the load and those
      // newer than the page.
      let kept: ReadonlyArray<TrukiBridgedEvent> = entry?.events ?? [];
      if (mode === 'replace') {
        const live = new Set(entry?.receivedWhileLoading ?? []);
        const pageMax = Math.max(-Infinity, ...events.map(e => e.streamOrder));
        kept = kept.filter(e => live.has(e.id) || e.streamOrder > pageMax);
      }
      return {
        ...state,
        messagesByChat: {
          ...state.messagesByChat,
          [chatId]: {
            events: upsertEvents(events, kept),
            hasOlder,
            loading: false,
          },
        },
      };
    }
    case LOGIN_STARTED: {
      const { processId, network, step, seq } = action.payload;
      let process: TrukiBridgeStateType['loginProcesses'][string] = {
        network,
        step,
        seq,
      };
      for (const pending of state.pendingLoginEvents[processId] ?? []) {
        process = applyLoginEvent(process, pending);
      }
      const pendingLoginEvents = { ...state.pendingLoginEvents };
      delete pendingLoginEvents[processId];
      // The network's open login now runs this process.
      const attempt = state.loginAttempts?.[network];
      const loginProcesses = { ...state.loginProcesses, [processId]: process };
      if (attempt?.processId && attempt.processId !== processId) {
        delete loginProcesses[attempt.processId];
      }
      return finishCompletedLogin(
        {
          ...state,
          loginProcesses,
          pendingLoginEvents,
          ...(attempt
            ? {
                loginAttempts: {
                  ...state.loginAttempts,
                  [network]: {
                    ...attempt,
                    stage: 'process',
                    processId,
                    busy: false,
                    error: undefined,
                  },
                },
              }
            : {}),
        },
        processId
      );
    }
    case ERROR_SET:
      return { ...state, lastError: action.payload };
    case ERROR_CLEARED:
      return state.lastError === undefined
        ? state
        : { ...state, lastError: undefined };
    case LOGIN_ATTEMPT_SET: {
      const { network, attempt } = action.payload;
      const stale = state.loginAttempts?.[network]?.processId;
      const loginAttempts = { ...state.loginAttempts };
      if (attempt) {
        loginAttempts[network] = attempt;
      } else {
        delete loginAttempts[network];
      }
      if (!stale || stale === attempt?.processId) {
        return { ...state, loginAttempts };
      }
      const loginProcesses = { ...state.loginProcesses };
      delete loginProcesses[stale];
      return { ...state, loginAttempts, loginProcesses };
    }
    case LOGIN_ATTEMPT_PATCHED: {
      const { network, patch } = action.payload;
      const attempt = state.loginAttempts?.[network];
      if (!attempt) {
        return state;
      }
      return {
        ...state,
        loginAttempts: {
          ...state.loginAttempts,
          [network]: { ...attempt, ...patch },
        },
      };
    }
    case RETRY_STARTED:
    case RETRY_FAILED: {
      const { chatId, eventId } = action.payload;
      const ids = (state.retriedByChat?.[chatId] ?? []).filter(
        id => id !== eventId
      );
      return {
        ...state,
        retriedByChat: {
          ...state.retriedByChat,
          [chatId]: action.type === RETRY_STARTED ? [...ids, eventId] : ids,
        },
      };
    }
    default:
      return state;
  }
}
