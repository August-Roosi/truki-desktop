# Truki Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not start a task before the previous one's tests pass and are committed.

**Goal:** Bridged WhatsApp / Messenger / Instagram chats appear in Signal's chat list, open in a Truki conversation view, can be connected from Settings, and can be placed in Spaces.

**Architecture:** A Truki preload client wraps the supervisor's IPC; a `trukiBridge` redux duck holds what is on screen; the inbox list helper merges a new `TrukiBridgedChat` row type into Signal's chat rows; `ChatsTab` shows `TrukiBridgedConversation` when a bridged chat is selected. Main-process additions (file dialog, cookie-login window, restart) live in the supervisor. Spaces membership is a local storage item.

**Tech Stack:** TypeScript, React, Redux (Signal's duck pattern), Electron IPC, Axo + `tw()`, electron-mocha + chai, Storybook; Go for bridge fixes (`truki-bridge/`, `scripts/test.sh`).

**Spec:** `docs/truki/specs/2026-10-21-truki-inbox-design.md` (§ numbers below refer to it). Wire protocol: `truki-bridge/PROTOCOL.md`. Repo rules: `AGENTS.md`.

## Global Constraints

- **Upstream Signal files may be edited only as listed in spec §8**, each edit an added branch/line; upstream behaviour unchanged when no bridged chats exist. Any other upstream file → stop and report.
- Never edit an upstream test; no `SCHEMA_VERSIONS`, protobuf or Signal SQL changes.
- Every Truki-owned file has `truki`/`Truki` in its path or name and the header `// Copyright 2026 Truki` / `// SPDX-License-Identifier: AGPL-3.0-only`. File suffixes are whatever `enforce-file-suffix` demands.
- New UI uses Axo (`ts/axo/`) and `tw()`; new strings go in `_locales/en/messages.json` with `icu:Truki…` keys only (no other locales).
- The renderer never receives or sends a file path or a cookie value; attachments go through `truki-bridge:pick-attachment` (main opens the dialog); cookies through the main-process login window.
- Bridged chats are never Signal `ConversationModel`s/`MessageModel`s and never enter Signal's search, archive, pinning or storage sync.
- Message text is never rendered as HTML; only the §4.2 allow-list (bold, italic, strikethrough, code, links) via React nodes.
- No automatic retries of sends; `RATE_LIMITED` is shown as "<Network> is limiting messages — try again later".
- IPC names are `truki-bridge:*`; storage key `trukiSpaceBridgedMembers`; settings page `SettingsPage.TrukiConnectedAccounts`; row type `RowType.TrukiBridgedChat`.
- Verification (AGENTS.md): quote literal summary lines. Linux baseline on this machine: `npx tsc --noEmit` → only `ts/updater/got.main.ts(5,8): error TS6133`; `npx oxlint` → only the `got.main.ts` no-unused-vars error; test-node via `env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a pnpm --config.verify-deps-before-run=false run test-node` → `2456 passing` / `11 pending` before this plan. Run `pnpm --config.verify-deps-before-run=false run build:protobuf` first if types mention `generalName`.

## Review Focus

1. **Hostile message content** (`<script>`, `<img onerror>`, `javascript:` / `file:` links, 100 KB bodies, RTL/zero-width text) → rendered inert, links only `http(s):`/`mailto:`, long bodies truncated with "Show more". Test in Task 4.
2. **Bridge restarts while a bridged chat is open** → view shows the unavailable banner, then reloads messages after `running`, with no duplicate bubbles. Test in Task 3 (duck) and Task 6 (view story + test).
3. **First message from a brand-new chat** (an `event.message` for a chat id not yet in `chats`) → chat appears at the top of the list without a manual refresh. Test in Task 3.
4. **Selected bridged chat disappears or its account logs out** → no crash; view shows Reconnect banner; selecting a Signal chat still works. Test in Task 6.
5. **Rapid switching between Signal and bridged chats** → exactly one conversation panel rendered; selection never stuck on both. Test in Task 5.

---

## File Map

```
truki-bridge/internal/trukiconnector/intent.go, …_test.go         T1, T8
truki-bridge/internal/store/events.go, upgrades/00-latest.sql, …   T1
truki-bridge/internal/host/config.go (+ test)                      T8
truki-bridge/internal/api/sink.go (+ test)                         T8
app/truki/trukiBridgeProtocol.std.ts                                T2
app/truki/TrukiBridgeSupervisor.main.ts (+ test)                    T2, T8
app/truki/trukiCookieLogin.main.ts (+ test, fixture page)           T9
app/main.main.ts                         (upstream: privileged scheme)   T2
ts/services/trukiBridgeClient.preload.ts                            T3
ts/state/ducks/trukiBridge.preload.ts                               T3
ts/state/selectors/trukiBridge.std.ts                               T3, T5, T11
ts/state/reducer.preload.ts, actions.preload.ts, getInitialState.preload.ts (upstream) T3
ts/util/trukiFormattedBody.dom.tsx                                  T4
ts/components/truki/TrukiBridgedChatRow.dom.tsx (+ stories)         T5
ts/util/trukiMergeChatRows.std.ts                                   T5
ts/components/ConversationList.dom.tsx, leftPane/LeftPaneInboxHelper.dom.tsx,
  state/smart/LeftPane.preload.tsx                (upstream)         T5
ts/components/truki/TrukiBridgedConversation*.dom.tsx (+ stories)   T6
ts/state/smart/TrukiBridgedConversation.preload.tsx                 T6
ts/components/ChatsTab.dom.tsx, state/smart/ChatsTab.preload.tsx (upstream) T6
ts/services/trukiBridgeNotifications.preload.ts                     T7
ts/components/truki/TrukiConnectedAccounts*.dom.tsx (+ stories)     T10
ts/state/smart/TrukiConnectedAccounts.preload.tsx                   T10
ts/types/Nav.std.ts, components/Preferences.dom.tsx,
  state/smart/Preferences.preload.tsx            (upstream)          T10
ts/types/StorageKeys.std.ts                      (upstream)          T11
ts/components/preferences/chatFolders/TrukiSpaceOtherNetworks.dom.tsx T12
ts/components/preferences/chatFolders/PreferencesEditChatFoldersPage.dom.tsx (upstream) T12
ts/test-node/truki/*                                                tests
```

---

## Phase 1 — Chats

### Task 1: Bridge redaction follow-ups (Go)

**Files:** Modify `truki-bridge/internal/trukiconnector/intent.go`, `internal/store/events.go`, `internal/store/upgrades/00-latest.sql` (edit in place; bridge DB has not shipped), `internal/trukiconnector/media.go`; tests in the same packages.

**Interfaces:** Produces `store.(*Store).AddTombstone(ctx, room id.RoomID, target id.EventID) error`, `store.(*Store).TakeTombstone(ctx, target id.EventID) (bool, error)`, `store.(*Store).MediaRefCount(ctx, mxc id.ContentURIString) (int, error)`; new table `redaction_tombstone(event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, created_at INTEGER NOT NULL)`.

- [ ] **Step 1: Failing tests.**
  - `TestRedactStripsEdits` (trukiconnector): message "secret words" + an `m.replace` edit "* secret words 2" → redact the original → the edit row's content has no `body`/`m.new_content`; `Search("secret")` empty.
  - `TestRedactionBeforeTarget`: redaction for an event id not yet stored → later `SendMessage` storing that id stores it with `Redacted=true` and no body; tombstone consumed.
  - `TestRedactDeletesUnreferencedMedia`: image message, redact → file under `media/` removed; a second event referencing the same mxc keeps the file until both are redacted.
- [ ] **Step 2: Run** `cd truki-bridge && scripts/test.sh -count=1 ./internal/store/ ./internal/trukiconnector/` → FAIL.
- [ ] **Step 3: Implement.** In `markRedacted`: also strip rows with `rel_type='m.replace'` and `relates_to=target`; when the target is missing, `AddTombstone`. In the store's insert path, `TakeTombstone` before insert and store redacted+stripped if found. Media: after stripping, for each mxc in the old content, delete the file when `MediaRefCount==0`.
- [ ] **Step 4: Run** the same command with `-race` → all `ok`.
- [ ] **Step 5: Commit** `truki(inbox): redaction strips edits, survives early arrival, frees media`.

### Task 2: Protocol helpers, attachment picker, privileged scheme

**Files:** Modify `app/truki/trukiBridgeProtocol.std.ts`, `app/truki/TrukiBridgeSupervisor.main.ts`, its test; upstream `app/main.main.ts` (one array entry).

**Interfaces:** Produces in `trukiBridgeProtocol.std.ts`:
```ts
export function mxcToTrukiMediaUrl(mxc: string): string | undefined; // mxc://truki.local/<64hex> → truki-media://truki.local/<64hex>
export function trukiMediaUrlToMxc(url: string): string | undefined;
export type TrukiPickAttachmentParams = { chatId: string; caption?: string; replyTo?: string };
```
IPC `truki-bridge:pick-attachment` (invoke, params `TrukiPickAttachmentParams`) → `TrukiBridgeIpcResult<{ eventId: string } | { cancelled: true }>`: main shows `dialog.showOpenDialog` (single file), then calls `request('messages.send', { chatId, text: caption ?? '', replyTo, attachments: [{ path, name, mimeType }] })`.

- [ ] **Step 1: Failing tests** (supervisor test file): `mxc round-trip` (valid, uppercase host normalised, rejects other hosts / non-hex / `..`); `pick-attachment cancelled` → `{ok:true,value:{cancelled:true}}` with no bridge request; `pick-attachment sends main-issued path` (dialog stubbed via an injected `showOpenDialog` option) → fake bridge receives `messages.send` with that path.
- [ ] **Step 2: Run** the focused supervisor test → FAIL.
- [ ] **Step 3: Implement**; add `showOpenDialog?: typeof dialog.showOpenDialog` to `TrukiBridgeSupervisorOptions` as a test seam; register the IPC in `startTrukiBridgeSupervisor`. In `app/main.main.ts` add one entry to the existing `registerSchemesAsPrivileged([...])` array: `{ scheme: 'truki-media', privileges: { standard: true, supportFetchAPI: true, stream: true } }`. Make the `truki-media` handler use `trukiMediaUrlToMxc`.
- [ ] **Step 4: Run** focused test → PASS; `git diff --stat main -- app/main.main.ts` shows only added lines.
- [ ] **Step 5: Commit** `truki(inbox): media URL helpers, attachment picker IPC, privileged truki-media`.

### Task 3: Renderer client and `trukiBridge` duck

**Files:** Create `ts/services/trukiBridgeClient.preload.ts`, `ts/state/ducks/trukiBridge.preload.ts`, `ts/state/selectors/trukiBridge.std.ts`, `ts/test-node/truki/trukiBridgeDuck_test.*.ts`, `ts/test-node/truki/trukiBridgeSelectors_test.std.ts`. Modify (upstream, one line each per spot) `ts/state/reducer.preload.ts`, `ts/state/actions.preload.ts`, `ts/state/getInitialState.preload.ts` (both the initial-state object and `getEmptyState`).

**Interfaces:**
```ts
// trukiBridgeClient.preload.ts
export function trukiBridgeRequest<T>(method: string, params?: unknown): Promise<TrukiBridgeIpcResult<T>>; // ipcRenderer.invoke('truki-bridge:request', …)
export function onTrukiBridgeEvent(cb: (e: TrukiBridgeEvent) => void): () => void;
export function trukiPickAttachment(p: TrukiPickAttachmentParams): Promise<TrukiBridgeIpcResult<{eventId:string}|{cancelled:true}>>;

// duck
export type TrukiBridgedChatSummary = { id: string; network: string; loginId: string; name: string;
  avatarMxc?: string; isDM: boolean; unreadCount: number; mutedUntil?: number; lastActivity: number;
  preview?: { text: string; fromMe: boolean } };
export type TrukiBridgedEvent = { id: string; chatId: string; sender: string; type: string; content: unknown;
  timestamp: number; streamOrder: number; status: '' | 'pending' | 'sent' | 'failed'; errorCode?: string;
  redacted: boolean; relatesTo?: string; relType?: string };
export type TrukiBridgeStateType = {
  bridgeState: 'stopped'|'starting'|'running'|'backoff'|'gave-up'|'unavailable';
  networks: ReadonlyArray<{ id: string; name: string; enabled: boolean }>;
  accounts: ReadonlyArray<{ loginId: string; network: string; remoteName: string; state: string; reason?: string }>;
  chats: Readonly<Record<string, TrukiBridgedChatSummary>>;
  selectedChatId: string | undefined;
  messagesByChat: Readonly<Record<string, { events: ReadonlyArray<TrukiBridgedEvent>; hasOlder: boolean; loading: boolean }>>;
  loginProcesses: Readonly<Record<string, { network: string; step: unknown; seq: number; error?: { code: string; message: string } }>>;
  pendingLoginEvents: Readonly<Record<string, ReadonlyArray<{ seq: number; step?: unknown; error?: { code: string; message: string } }>>>;
};
export function getEmptyState(): TrukiBridgeStateType;  // bridgeState 'stopped', empty collections
export const actions: { trukiBridgeStart, trukiBridgeEventReceived, loadChats, selectBridgedChat,
  clearBridgedSelection, loadOlderMessages, sendText, sendReaction, redactMessage, markRead, setMuted, retrySend };
export const useTrukiBridgeActions: () => BoundActionCreatorsMapObject<typeof actions>;
// selectors
export const getTrukiBridge: (s: StateType) => TrukiBridgeStateType;
export const getTrukiSelectedChatId: (s: StateType) => string | undefined;
export const getTrukiChatList: (s: StateType) => ReadonlyArray<TrukiBridgedChatSummary>; // lastActivity desc, ties by id
```
`trukiBridgeStart` (thunk) subscribes once to events (idempotent), loads `networks.list`, `accounts.list`, `chats.list` (all pages). It is dispatched from Task 5's smart LeftPane on mount.

- [ ] **Step 1: Failing reducer tests** (pure reducer, no IPC): `event.message` for an existing chat updates preview/lastActivity/unread; **for an unknown chat id creates a placeholder summary and the chat sorts first** (Review Focus 3, followed by a `chats.get` load in the thunk); same event id twice → one event (update in place); status `pending→sent→failed` transitions; redacted event loses body; `event.chat` upserts; `event.accountState` with empty `loginId` ignored, else replaces the account row incl. `reason`; `event.login.step` with lower `seq` ignored; step for unknown `processId` buffered then flushed by `loginStarted`; **bridge state → `stopped` then `running` keeps chats, clears `messagesByChat.loading`, and reload of an open chat replaces (not appends) its events** (Review Focus 2); `selectBridgedChat(id)` sets id, `clearBridgedSelection` clears it.
- [ ] **Step 2: Failing selector tests:** `getTrukiChatList` ordering.
- [ ] **Step 3: Run** `… run test-node -- --grep trukiBridge` → FAIL.
- [ ] **Step 4: Implement** client, duck, selectors; register: `reducer.preload.ts` (`trukiBridge` import + key), `actions.preload.ts` (`trukiBridge` actions), `getInitialState.preload.ts` (`trukiBridge: trukiBridgeEmptyState()` in both objects). Thunks map every `TrukiBridgeIpcResult` `ok:false` to a toast-able error in state, never throw.
- [ ] **Step 5: Run** focused tests → PASS; `npx tsc --noEmit` at baseline.
- [ ] **Step 6: Commit** `truki(inbox): renderer client and trukiBridge state`.

### Task 4: Safe formatted-body renderer

**Files:** Create `ts/util/trukiFormattedBody.dom.tsx`, `ts/test-node/truki/trukiFormattedBody_test.dom.tsx`.

**Interfaces:** `export function TrukiFormattedBody(props: { body: string; formattedBody?: string; format?: string; maxLength?: number }): JSX.Element` — parses `formatted_body` with `DOMParser` (never `innerHTML` into the live DOM), walks nodes, emits React elements only for `b/strong, i/em, s/del/strike, code, pre, br, a[href]`; everything else becomes its text content. Links: only `http:`, `https:`, `mailto:`; rendered via Signal's existing external-link component/handler (find it; do not open URLs directly). `maxLength` default 4000 → truncated with a "Show more" toggle.

- [ ] **Step 1: Failing tests** (render with react-dom/server or testing-library as other `.dom` tests do): plain body; bold/italic/strike/code mapping; `<script>alert(1)</script>hi` → text `hi` only, no script element; `<img src=x onerror=…>` dropped; `<a href="javascript:alert(1)">x</a>` → plain text `x`; `<a href="https://e.ee">x</a>` → link; 100 000-char body → truncated + "Show more"; RTL and zero-width characters preserved as text (Review Focus 1).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `truki(inbox): safe formatted message body`.

### Task 5: Chat list merge and bridged row

**Files:** Create `ts/util/trukiMergeChatRows.std.ts`, `ts/components/truki/TrukiBridgedChatRow.dom.tsx` (+ `.dom.stories.tsx`), tests `ts/test-node/truki/trukiMergeChatRows_test.std.ts`, `ts/test-node/truki/trukiSelection_test.*.ts`. Modify (upstream) `ts/components/ConversationList.dom.tsx`, `ts/components/leftPane/LeftPaneInboxHelper.dom.tsx`, `ts/state/smart/LeftPane.preload.tsx`.

**Interfaces:**
```ts
export type TrukiMergedRow =
  | { kind: 'signal'; conversation: ConversationListItemPropsType }
  | { kind: 'truki'; chat: TrukiBridgedChatSummary };
export function trukiMergeChatRows(signal: ReadonlyArray<ConversationListItemPropsType>,
  bridged: ReadonlyArray<TrukiBridgedChatSummary>): ReadonlyArray<TrukiMergedRow>;
// by activity desc (Signal: lastUpdated ?? 0; bridged: lastActivity); ties: Signal first, then id
```
- `ConversationList.dom.tsx`: `RowType.TrukiBridgedChat = 'TrukiBridgedChat'`, row type `{ type: RowType.TrukiBridgedChat; chat: TrukiBridgedChatSummary; isSelected: boolean; onSelect: (id: string) => void }`, render branch → `<TrukiBridgedChatRow …/>`; give it the conversation row height.
- `LeftPaneInboxHelper.dom.tsx`: optional prop `trukiBridgedChats?: ReadonlyArray<TrukiBridgedChatSummary>` (+ `trukiSelectedChatId?`, `onSelectTrukiChat?`). When absent or empty, every method behaves exactly as before. When present, the unpinned section iterates `trukiMergeChatRows(conversations, trukiBridgedChats)`; `getRowCount`, `getRow`, `getRowIndexToScrollTo` and `getConversationAndMessageAtIndex` use the merged list (bridged rows are skipped by keyboard "next/previous conversation" navigation — they return the next Signal row).
- `smart/LeftPane.preload.tsx`: dispatch `trukiBridgeStart` once on mount; pass `getTrukiChatList` (filtered by the selected Space in Task 11; unfiltered until then), selection and `selectBridgedChat`.
- Selecting a bridged row calls `selectBridgedChat(id)` and Signal's `showConversation({ conversationId: undefined })` so only one is selected (Review Focus 5 — wired fully in Task 6).

- [ ] **Step 1: Failing tests:** `trukiMergeChatRows` ordering incl. ties and empty inputs; helper with no bridged chats → identical rows/counts to before (snapshot of `getRow` for a fixture); helper with 2 bridged chats → rows interleaved, count +2, archive button still last.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, row with avatar + network badge (`WA`/`FB`/`IG` monogram badge, Axo), name, preview, time, unread badge, muted dim, disconnected grey + tooltip; context menu Mute/Unmute, Mark read (Add to Space… in Task 12). Stories: default, unread, muted, disconnected, very long / RTL / emoji-only name.
- [ ] **Step 4: Run** focused tests → PASS; tsc + oxlint at baseline.
- [ ] **Step 5: Commit** `truki(inbox): bridged chats in the chat list`.

### Task 6: Conversation view and panel switch

**Files:** Create `ts/components/truki/TrukiBridgedConversation.dom.tsx` + children (`…Header`, `…Timeline`, `…Bubble`, `…Composer`, `…Banner` — one responsibility each) + stories; `ts/state/smart/TrukiBridgedConversation.preload.tsx`; tests. Modify (upstream) `ts/components/ChatsTab.dom.tsx` (optional props `trukiSelectedChatId?: string; renderTrukiConversation?: (id: string) => JSX.Element` — when set, render it in the conversation stack instead of the Signal view/splash), `ts/state/smart/ChatsTab.preload.tsx` (pass them; when Signal's `selectedConversationId` becomes defined, dispatch `clearBridgedSelection`).

**Interfaces:** consumes duck actions from Task 3, `TrukiFormattedBody` (Task 4), `mxcToTrukiMediaUrl` + `trukiPickAttachment` (Task 2).

Behaviour per spec §4.2: paging on scroll-up (`loadOlderMessages`), bubbles with ⏳/✓/⚠+Retry (`retrySend` = new `sendText` with the same text; never automatic), replies (quote), reactions aggregated + Signal's emoji picker for reacting, redacted placeholder, edited label (latest `m.replace` wins), images/videos via `truki-media://`, files as cards, incoming typing indicator, composer Enter/Shift+Enter, reply action, attachment button → `trukiPickAttachment`, "Delete for everyone" on own messages, `markRead` when scrolled to bottom. Banners: bridge not running (Restart arrives in Task 10 — until then text only), account logged out (Reconnect arrives in Task 10), `RATE_LIMITED` toast.

- [ ] **Step 1: Failing tests:** smart/selection test: select bridged → ChatsTab renders Truki view; then select Signal conversation → Truki selection cleared and Signal view rendered; alternate 20 times → never both (Review Focus 5). View test: selected chat removed from `chats` → renders "chat unavailable" without throwing; account state `LOGGED_OUT` → Reconnect banner (Review Focus 4); bridge `stopped`→`running` → messages reloaded once, no duplicates (Review Focus 2).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + stories (pending/failed/redacted/edited/reply/reactions/image/file/long text/bridge down/logged out).
- [ ] **Step 4: Run** focused tests → PASS; tsc + oxlint at baseline.
- [ ] **Step 5: Commit** `truki(inbox): bridged conversation view`.

### Task 7: Notifications

**Files:** Create `ts/services/trukiBridgeNotifications.preload.ts` + test.

**Interfaces:** `export function handleTrukiBridgeNotify(e: { chatId: string; senderName: string; preview: string; network: string }, deps: { getSetting: () => NotificationSettingType; isChatMuted: (id: string) => boolean; isChatOpenAndFocused: (id: string) => boolean; show: (title: string, body: string, onClick: () => void) => void; selectChat: (id: string) => void }): void` — honours Signal's `'notification-setting'` (`off` → nothing; `name` → sender only, no preview; `count` → generic text; `message` → sender + preview), skips muted and currently open+focused chats; click focuses the window and selects the chat. Wired from the duck's event subscription with `show` = `new Notification(...)`.

- [ ] **Step 1: Failing tests** for each setting value, muted, open+focused, click → `selectChat`.
- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Commit** `truki(inbox): desktop notifications for bridged chats`.

**Phase 1 checkpoint:** full verification (tsc, oxlint, full test-node, `truki-bridge` `scripts/test.sh -count=1 ./...`), literal summary lines in the task report.

## Phase 2 — Accounts

### Task 8: Bridge and supervisor fixes for accounts

**Files:** Modify `truki-bridge/internal/api/sink.go` (+ test), `truki-bridge/internal/host/config.go` (+ test), `app/truki/TrukiBridgeSupervisor.main.ts` (+ test).

- `event.accountState` params gain `reason?: string` (BridgeState `error` + `message`, joined, no secrets) — update PROTOCOL.md.
- WhatsApp network config overrides applied after loading the example YAML: `os_name: "Trüki"`, `browser_name: "unknown"` (keep whatever key mautrix-whatsapp v0.2610.0 uses for the device name — check the example config), `displayname_template` without the ` (WA)` suffix, `enable_status_broadcast: false`.
- Supervisor: `restart(): Promise<void>` (stop if running, reset `#crashTimes`, clear gave-up, start if networks enabled) exposed as IPC `truki-bridge:restart`; atomic key write (write `*.tmp`, fsync, rename); `log.warn` once when `safeStorage` is unavailable; expose `bridgeState` changes as an event `event.supervisorState { state }` to the renderer (feeds `TrukiBridgeStateType.bridgeState`, incl. `unavailable`).
- [ ] Tests first: sink reason present / no reason for global states; config overrides per key; `restart` from gave-up spawns again; key file write leaves no `.tmp` and survives a simulated crash between write and rename (old key intact); supervisorState events emitted on transitions. Run FAIL → implement → PASS → commit `truki(inbox): account state reasons, restart, WhatsApp device name`.

### Task 9: Cookie login window (main)

**Files:** Create `app/truki/trukiCookieLogin.main.ts`, test + local fixture page `ts/test-node/truki/fixtures/trukiFakeLoginPage.node.mjs` (tiny HTTP server setting cookies after a form post).

**Interfaces:** `export function openTrukiCookieLogin(opts: { url: string; requiredCookies: ReadonlyArray<{ name: string; domain?: string }>; partition?: string; createWindow?: …; timeoutMs?: number }): Promise<{ cookies: Record<string, string> } | { cancelled: true }>` — fresh `session.fromPartition('truki-login-<uuid>')` (non-persistent), loads `url`, polls/observes `session.cookies` until all required cookies exist, then `session.clearStorageData()`, closes the window, resolves. User closing the window → `{ cancelled: true }`. IPC `truki-bridge:cookie-login` (params `{ processId, stepId }`): main reads the step's cookie spec from the bridge's last `event.login.step` for that process (kept in the supervisor), runs `openTrukiCookieLogin`, then `login.submit` with the cookies; returns `TrukiBridgeIpcResult<void>`. The renderer only gets ok/cancelled/error.

- [ ] Tests first (against the fixture server): all cookies → resolves with values and the partition is cleared; window closed → cancelled; missing cookie until timeout → error; IPC path never returns cookie values to the caller. Run FAIL → implement → PASS → commit `truki(inbox): main-process cookie login window`.

### Task 10: Connected accounts page and login UI

**Files:** Create `ts/components/truki/TrukiConnectedAccounts.dom.tsx`, `TrukiLoginFlow.dom.tsx`, `TrukiBanRiskDialog.dom.tsx` (+ stories), `ts/state/smart/TrukiConnectedAccounts.preload.tsx`, tests; duck additions (`startLogin`, `submitLoginInput`, `cancelLogin`, `startCookieLogin`, `logout`, `enableNetwork`, `restartBridge`). Modify (upstream) `ts/types/Nav.std.ts` (`TrukiConnectedAccounts = 'TrukiConnectedAccounts'` in `SettingsPage`), `ts/components/Preferences.dom.tsx` (nav item + `else if (settingsLocation.page === SettingsPage.TrukiConnectedAccounts)` branch calling a new optional render prop `renderTrukiConnectedAccounts?`), `ts/state/smart/Preferences.preload.tsx` (pass the render prop).

Behaviour per spec §5: per-network rows with account status + reason; Connect → ban-risk dialog on first enable per network (remember acceptance in the Truki storage item `trukiBridgeBanRiskAccepted: ReadonlyArray<string>` — add this key to `StorageKeys.std.ts` in Task 11's edit, or here if Task 11 has not run; it is the same upstream file and the same kind of one-line addition) → `enableNetwork` → flows from `login.flows` → steps: QR via Signal's `QrCode`, `user_input` form, pairing code display, `cookies` → `startCookieLogin`; errors with Try again; Cancel → `login.cancel`. Bridge banner with Restart / "Secure storage unavailable". The Task 6 banners get their Restart/Reconnect buttons wired here.

- [ ] Tests first: flow state machine from a sequence of step events (QR refresh replaces the QR; complete returns to list; error → Try again); ban-risk dialog shown only once per network; Preferences renders the page when the location is set (smart test). Run FAIL → implement + stories → PASS; tsc + oxlint at baseline → commit `truki(inbox): connected accounts and login screens`.

**Phase 2 checkpoint:** full verification as in Phase 1.

## Phase 3 — Spaces

### Task 11: Spaces membership store and filtering

**Files:** Create `ts/services/trukiSpaceMembers.preload.ts`, tests; extend `ts/state/selectors/trukiBridge.std.ts`. Modify (upstream) `ts/types/StorageKeys.std.ts` (`trukiSpaceBridgedMembers: TrukiSpaceBridgedMembers;` and, if not yet added, `trukiBridgeBanRiskAccepted`).

**Interfaces:**
```ts
export type TrukiSpaceBridgedMembers = Readonly<Record<string /* ChatFolderId */, { chatIds: ReadonlyArray<string>; networks: ReadonlyArray<string> }>>;
export function getTrukiSpaceMembers(): TrukiSpaceBridgedMembers;
export function setTrukiSpaceMembers(folderId: string, m: { chatIds: ReadonlyArray<string>; networks: ReadonlyArray<string> }): Promise<void>;
export function removeTrukiSpace(folderId: string): Promise<void>;
export function trukiChatInSpace(chat: TrukiBridgedChatSummary, members: TrukiSpaceBridgedMembers[string] | undefined): boolean;
export const getTrukiChatListForFolder: (s: StateType, folder: ChatFolder | null) => ReadonlyArray<TrukiBridgedChatSummary>;
```
Rules (spec §6.2): CUSTOM folder → chats in `chatIds` or whose network is in `networks`; ALL folder → every bridged chat except those in any folder with `hideFromAllChats`; unread totals per folder include bridged unread. Deleting a chat folder removes its entry (subscribe to the chatFolders duck's delete action in the Truki service, no upstream edit).

- [ ] Tests first: membership by chat id, by network, both; ALL hides chats from hide-from-General spaces; folder deletion cleans up; unread totals. Run FAIL → implement; switch Task 5's `smart/LeftPane` to `getTrukiChatListForFolder` (Truki line already present there) → PASS → commit `truki(inbox): bridged chats in Spaces`.

### Task 12: Space editor section and "Add to Space…"

**Files:** Create `ts/components/preferences/chatFolders/TrukiSpaceOtherNetworks.dom.tsx` (+ story), tests. Modify (upstream) `PreferencesEditChatFoldersPage.dom.tsx` (insert the component next to `TrukiSpaceColorPicker`, props via an optional render prop from its smart parent if the page needs redux — check how `TrukiSpaceColorPicker` gets its data and follow that). Extend `TrukiBridgedChatRow` context menu with "Add to Space…" (Space picker listing custom Spaces).

- [ ] Tests first: section lists only networks with a connected account; toggling a network / picking a chat calls `setTrukiSpaceMembers` with the right payload; "Add to Space…" adds the chat id. Run FAIL → implement → PASS; tsc + oxlint at baseline → commit `truki(inbox): edit Space membership for bridged chats`.

### Task 13: Final verification and docs

**Files:** Modify `truki-bridge/PROTOCOL.md` (any remaining notes), `docs/truki/plans/2026-10-20-truki-bridge-followups.md` (strike the items this plan closed), `TRUKI.md` (release step `pnpm run build:truki-bridge` before `pnpm run build`).

- [ ] Run and quote: `npx tsc --noEmit`, `npx oxlint`, full test-node, `cd truki-bridge && scripts/test.sh -count=1 ./...`; `git diff --stat main -- <each upstream file in spec §8>` shows only additions; Storybook builds the new stories (`pnpm run build:storybook` or the repo's equivalent).
- [ ] Commit `truki(inbox): docs and release step`.
