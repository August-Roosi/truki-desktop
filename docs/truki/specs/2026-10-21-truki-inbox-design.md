# Truki Inbox — Design

Status: draft 2026-10-21
Fork base: upstream Signal Desktop `v8.27.0`
Sub-project: 2 of the Truki Bridge work (follows
`2026-10-20-truki-bridge-design.md`, which built `truki-bridge` and the
main-process supervisor)

## 1. Purpose

Show WhatsApp, Facebook Messenger and Instagram chats **inside Signal's own
chat list**, let the user read and send in them, connect their accounts from
Settings, and put bridged chats into Spaces — so Truki is one inbox.

### 1.1 Decisions already made

- **Mixed into Chats.** Bridged chats appear in Signal's chat list, sorted
  together with Signal chats by last activity. No separate Inbox tab.
- **Own row type + own conversation view.** Bridged chats are a new row type
  in the chat list; selecting one shows a Truki conversation view in the
  right panel. They are **never** Signal `ConversationModel`s or
  `MessageModel`s, so they cannot be sent over Signal, synced to Signal's
  storage service, or confused with Signal contacts.
- **Scope:** chats, account login screens, and Spaces membership — delivered
  in three phases (§9), each usable on its own.
- **Spaces membership:** individual bridged chats and/or whole networks,
  stored locally, never synced.

## 2. Prime constraint

AGENTS.md's prime directive applies. A unified chat list cannot avoid
touching Signal's list and conversation panel, so the target is **every
upstream edit an added branch, in the files listed in §8 and nowhere else**.
All behaviour lives in new Truki-owned files.

## 3. Architecture

```
Renderer                                         Main process
┌──────────────────────────────────────────┐    ┌──────────────────────────┐
│ ChatsTab ──selected bridged chat?──┐     │    │ TrukiBridgeSupervisor    │
│   ├─ SmartConversationView (Signal)│     │    │  truki-bridge:request ◀──┼── ipcRenderer.invoke
│   └─ TrukiBridgedConversation ◀────┘     │    │  truki-bridge:event   ──┼─▶ webContents.send
│ LeftPane ─ LeftPaneInboxHelper           │    │  truki-bridge:pick-…  ◀──┼── file dialog (main)
│   └─ rows: Conversation | TrukiBridgedChat│   │  truki-bridge:login-… ◀──┼── cookie login window
│ Preferences ─ TrukiConnectedAccounts     │    │  truki-media://        ──┼─▶ media files
│ Space editor ─ TrukiSpaceOtherNetworks   │    └──────────────────────────┘
│                                          │                 │ stdio JSON-RPC
│ state: ducks/trukiBridge (+ selectors)   │                 ▼
│ preload client: trukiBridgeClient        │          truki-bridge.exe
└──────────────────────────────────────────┘
```

### 3.1 Renderer access

Signal's redux and service code runs in the preload, which imports
`ipcRenderer` directly (as `ducks/backups.preload.ts` does). A new Truki
module `ts/services/trukiBridgeClient.preload.ts` wraps the IPC:
`trukiBridgeRequest(method, params)`, `onTrukiBridgeEvent(cb)`,
`trukiPickAttachment(params)`, plus restart / cookie-login calls. No window
global and no preload-entry edit are needed. Results use the existing
`TrukiBridgeIpcResult`; the renderer never passes a file path or a cookie
value.

### 3.2 State

New duck `ts/state/ducks/trukiBridge.preload.ts` and selectors
`ts/state/selectors/trukiBridge.std.ts`:

- `networks`, `accounts` (with state + error reason), `bridgeState`
  (`stopped|starting|running|backoff|gave-up|unavailable`).
- `chats: Record<chatId, TrukiBridgedChatSummary>` — name, avatar mxc,
  network, loginId, unread, muted, lastActivity, last-message preview.
- `selectedChatId`, `messagesByChat: Record<chatId, {events, hasOlder,
  loading}>` — only for chats that have been opened.
- `loginProcesses: Record<processId, {network, step, seq, error}>`.
- `spaceMembers` (§6).

The bridge stays the source of truth: the renderer keeps what is on screen
in memory; nothing bridged is written to Signal's database. Events update
the state live: `event.message` (insert/update by id, honouring
`status`/redaction), `event.chat`, `event.accountState`,
`event.login.step` (applied only if its `seq` is higher than the stored
one; steps for unknown `processId`s are buffered until the `login.start`
response arrives), `event.typing`, `event.receipt`, `event.notify`.

### 3.3 Selection

`selectedChatId` (bridged) and Signal's selected conversation are mutually
exclusive: selecting one clears the other. `ChatsTab` renders
`TrukiBridgedConversation` when a bridged chat is selected.

## 4. Chat list and conversation view

### 4.1 List row

`ts/components/truki/TrukiBridgedChatRow.dom.tsx`, same geometry as Signal's
conversation row: avatar with a small network badge (WhatsApp / Messenger /
Instagram), name, preview, time, unread badge, dimmed when muted, grey badge
+ tooltip when its account is disconnected. Merged into the inbox list by
`lastActivity` (ties: Signal chats first, then chat id). Bridged rows are not
pinnable and are not shown in Signal's archive view or search results in v1.
Context menu: Mute / Unmute, Add to Space… (§6), Mark read.

### 4.2 Conversation view

`ts/components/truki/TrukiBridgedConversation.dom.tsx` + children, Axo +
`tw()`, visually modelled on Signal's conversation:

- **Header:** name, network, account; mute menu (`chats.setMuted`).
- **Timeline:** `messages.list` paging (newest at bottom, load older on
  scroll up). Bubble states: pending ⏳, sent ✓, failed ⚠ with a manual
  Retry (sends a new message — never automatic). Text rendering: plain text
  with an allow-list of formatting derived from `formatted_body`
  (bold, italic, strikethrough, inline/monospace code, links opened via
  Signal's external-link handling) — never raw HTML. Images/videos via
  `truki-media://`; other files as file cards (save via main process).
  Replies show a quote of the target; reactions aggregated under the bubble;
  redacted messages show "This message was deleted"; edits show the latest
  text with an "edited" label. Incoming typing indicators shown.
- **Composer:** Enter sends, Shift+Enter newline; reply (hover action);
  reaction picker reusing Signal's emoji picker; attachment button →
  `pickAttachment` (file dialog in main, path handed to the bridge by main —
  closes ruling R19's gap); "Delete for everyone" on own messages
  (`messages.redact`).
- **Read state:** opening the chat or reaching the bottom calls
  `chats.markRead` with the newest event id.
- **Notifications:** `event.notify` → a Truki service that shows an
  Electron/HTML `Notification` directly, honouring Signal's
  `notification-setting` (off / name / count / message), skipping muted and
  currently open chats; clicking focuses the window and selects the bridged
  chat. Signal's `notificationService` is not edited (it is built around
  Signal conversations).

Out of v1: voice notes, sending stickers, sending typing indicators,
forwarding, message info.

## 5. Connected accounts and login

### 5.1 Settings page

A new Settings page **Connected accounts**: one added `SettingsPage` value,
nav item and render branch in `Preferences.dom.tsx`; the page is
`ts/components/truki/TrukiConnectedAccounts.dom.tsx`.

- Per network: connected accounts with status (connected, connecting,
  logged out, error + reason), **Connect** and **Log out**.
- Bridge banner: "Bridges stopped" + **Restart** (new supervisor
  `restart()`; resets the crash counter — spec §6.1 "until the user restarts
  it"), or "Secure storage unavailable on this system" when `safeStorage`
  is unavailable (the supervisor now logs a warning too).

### 5.2 Connect flow

1. First connect per network: **ban-risk warning dialog** (the network may
   suspend accounts that use unofficial clients); confirming enables the
   network (`setEnabledNetworks`), which starts the bridge.
2. Choose a flow from `login.flows`; drive steps from `login.start` /
   `login.submit` / `event.login.step`:
   - `display_and_wait` QR (WhatsApp): rendered with Signal's `QrCode`
     component, refreshed on each new step; Cancel; timeout message.
   - `user_input` (pairing code phone number): form; then the code shown large.
   - `cookies` (Messenger, Instagram): `startCookieLogin` opens a **login
     window** in main with a fresh, non-persistent session partition, loading
     the network's login URL from the step. Main watches the partition's
     cookie store; once every cookie the step requires is present, main
     calls `login.submit` with them, then clears the partition and closes the
     window. Cookies never reach the renderer.
3. Errors show the network's message with **Try again**; `login.cancel` on
   close.

### 5.3 Bridge-side fixes included

- `event.accountState` carries the BridgeState error/message; global states
  with empty `loginId` are ignored by the renderer.
- Atomic write of `truki-bridge.key` (tmp + fsync + rename).
- WhatsApp network config overrides: device name **"Trüki"** in the phone's
  Linked devices; no " (WA)" suffix on display names; status broadcast off.

## 6. Spaces

### 6.1 Storage

Truki-owned Signal storage item `trukiSpaceBridgedMembers`:

```ts
type TrukiSpaceBridgedMembers = Record<ChatFolderId, {
  chatIds: ReadonlyArray<string>;      // bridged chat ids (store.Chat.ID)
  networks: ReadonlyArray<string>;     // 'whatsapp' | 'meta' | 'instagram'
}>;
```

One added key in `ts/types/StorageKeys.std.ts`. Storage items are local; not
synced by the storage service. Deleting a Space removes its entry (a
Truki-owned listener on chat-folder deletion).

### 6.2 Filtering

- A selected Space shows its Signal chats (unchanged) plus bridged chats
  listed in `chatIds` or whose network is in `networks`.
- General (all chats) shows all bridged chats except those included in any
  Space with `hideFromAllChats` — the same rule Spaces apply to Signal chats.
- Space unread counts include bridged chats.

### 6.3 Editing

The Space editor (`PreferencesEditChatFoldersPage.dom.tsx`) gets one
inserted Truki component `TrukiSpaceOtherNetworks.dom.tsx`: a checkbox per
network with a connected account ("All WhatsApp chats", …) and a searchable
picker of individual bridged chats. Bridged chat context menu "Add to
Space…" writes the same store.

## 7. Failure handling

- Bridge not running (stopped, gave-up, unavailable): bridged rows stay from
  the last list, greyed; the conversation view shows a banner with Restart;
  composer disabled.
- Account logged out / bad credentials: banner with **Reconnect** (opens
  §5.2 for that network).
- Every request result goes through `TrukiBridgeIpcResult`; failures show an
  inline error or toast mapped from the code — never an uncaught error in
  the renderer.
- `RATE_LIMITED`: "<Network> is limiting messages — try again later"; no
  automatic retry.

### 7.1 Remaining bridge follow-ups included

- Redacting a message also strips its edits (`m.replace` rows) and removes
  them from FTS.
- A redaction that arrives before its target is remembered (tombstone); the
  target is stored already redacted when it arrives.
- A redacted message's media file is deleted once no other event references
  it.
- `truki-media` added to upstream's `registerSchemesAsPrivileged` list
  (`standard`, `supportFetchAPI`, `stream`); the renderer's mxc → URL
  encoding mirrors the main-process decoding exactly (host lowercased, path
  percent-encoded), with a shared helper in `trukiBridgeProtocol.std.ts`.

## 8. Upstream edits (complete list)

| File | Change |
|------|--------|
| `ts/components/ConversationList.dom.tsx` | `RowType.TrukiBridgedChat` + its row type + render branch |
| `ts/components/leftPane/LeftPaneInboxHelper.dom.tsx` | merge bridged rows into the inbox list |
| `ts/state/smart/LeftPane.preload.tsx` | pass bridged chat summaries (filtered by Space) to the helper |
| `ts/components/ChatsTab.dom.tsx` | optional `trukiSelectedChatId` + `renderTrukiConversation` props; render it instead of the Signal view when set |
| `ts/state/smart/ChatsTab.preload.tsx` | pass those props; clear the bridged selection when a Signal chat is selected |
| `ts/state/reducer.preload.ts` | register the `trukiBridge` duck |
| `ts/state/getInitialState.preload.ts` | `trukiBridge` empty state in `getEmptyState` (the initial state inherits it, and a re-init keeps the existing slice) |
| `ts/components/Preferences.dom.tsx` | Connected accounts nav item + render branch (optional render prop) |
| `ts/state/smart/Preferences.preload.tsx` | pass the Connected accounts render prop |
| `ts/types/Nav.std.ts` | `SettingsPage.TrukiConnectedAccounts` |
| `ts/types/StorageKeys.std.ts` | `trukiSpaceBridgedMembers` and `trukiBridgeBanRiskAccepted` keys |
| `ts/components/preferences/chatFolders/PreferencesEditChatFoldersPage.dom.tsx` | insert `TrukiSpaceOtherNetworks` |
| `ts/state/smart/PreferencesEditChatFolderPage.preload.tsx` | Truki hook + one `{...trukiProps}` spread passing the Space-members section and wrapped create/update |
| `app/main.main.ts` | `truki-media` entry in `registerSchemesAsPrivileged` |
| `background.html` | `truki-media:` added to the img-src and media-src CSP lists |

Each is an added branch/line; upstream behaviour is unchanged when there are
no bridged chats. If implementation needs any file not in this table, stop
and revisit the design. No `SCHEMA_VERSIONS` entry, no protobuf field, no
Signal SQL change.

## 9. Phases

1. **Chats** — preload API, duck/selectors, list merge, row, conversation
   view, attachments via main, notifications, `truki-media` privileged
   scheme, bridge redaction fixes (§7.1).
2. **Accounts** — Connected accounts page, warning dialog, QR / pairing /
   cookie-window logins, bridge banner + Restart, accountState reason, atomic
   key write, WhatsApp config overrides.
3. **Spaces** — membership store, filtering, editor section, "Add to Space…".

Each phase ends with AGENTS.md verification at baseline and can be merged on
its own.

## 10. Testing

- Go unit tests for each bridge fix (§5.3, §7.1).
- Node tests (`ts/test-node/truki/…`): duck reducers for every event,
  `seq` ordering and buffering, selectors (merge order, Space filtering,
  hide-from-General), mxc ↔ `truki-media` encoding round-trip, formatted-body
  allow-list (no HTML passes through), supervisor additions (`restart`,
  `pickAttachment`, cookie-login cookie detection against a local fake login
  page).
- Storybook stories: bridged chat row (all states), conversation view
  (pending / failed / redacted / edited / reply / reactions / media),
  Connected accounts page and each login step.
- Upstream tests must pass unchanged; `check:types` and `oxlint` stay at
  baseline (measured per machine, quoted literally).

## 11. Out of scope

- Bridged chats in Signal's search, archive, pinning.
- Voice notes; sending stickers or typing indicators; forwarding.
- Networks beyond WhatsApp, Messenger, Instagram; Linux/macOS packaging.
- Syncing Spaces membership to other devices.
