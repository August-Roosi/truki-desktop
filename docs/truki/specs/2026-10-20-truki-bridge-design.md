# Truki Bridge — Design

Status: draft 2026-10-20
Fork base: upstream Signal Desktop `v8.27.0`
Sub-project: 1 of 4 (bridge program + supervisor)

## 1. Purpose

Let Truki users read and send messages from other networks — starting with
WhatsApp, Messenger/Facebook and Instagram — without a server and without a
third-party service such as Beeper.

Truki bundles a Go program, `truki-bridge`, which embeds the open-source
mautrix bridge **network connectors** as Go libraries and replaces their
Matrix side with local storage. Truki talks to it over a private stdio pipe.

### 1.1 Who it is for

Anyone who installs Truki from its update server. That sets the bar:

- Zero setup. No server, no config files, no terminal.
- Every network is **off by default**. Enabling one shows a warning that the
  network may suspend accounts that use unofficial clients.
- `truki-bridge` is AGPL-3.0 like Truki and the mautrix bridges, and its
  source ships in this repo.
- Windows x64 only, matching Truki's current releases. Linux and macOS later.

### 1.2 The four sub-projects

1. **This spec:** `truki-bridge` + `TrukiBridgeSupervisor` in Truki's main
   process + packaging.
2. Inbox UI in Truki Desktop (separate pane, own state; not mixed into
   Signal's conversation model).
3. Login screens (QR display, cookie capture in a `BrowserWindow`, account
   status).
4. Further networks and platforms.

Each later sub-project gets its own spec.

## 2. Prime constraint

AGENTS.md's prime directive applies: minimal, additive changes to upstream
files. The Go program lives in a new top-level folder, so it has zero merge
conflict surface. The target for upstream edits in this sub-project is
**2 files and about 6 lines**, all additive.

The second constraint is new: **mautrix updates must stay cheap too.** The
bridges are consumed as Go module dependencies, never forked or vendored with
edits. Updating them is `go get -u` plus a rebuild. Truki-owned Go code only
implements mautrix-go's published interfaces.

## 3. Architecture

```
Truki main process                      truki-bridge.exe (child process)
┌───────────────────────────┐  stdin   ┌──────────────────────────────────┐
│ TrukiBridgeSupervisor     │ ───────▶ │ internal/rpc (JSON-RPC 2.0)      │
│  - lazy start / restart   │ ◀─────── │   │                              │
│  - key from safeStorage   │  stdout  │   ├─ internal/login              │
│  - IPC to renderer        │          │   ├─ internal/store (SQLCipher)  │
│  - truki-media: protocol  │ ◀─────── │   └─ internal/trukiconnector     │
└───────────────────────────┘  stderr  │        (bridgev2.MatrixConnector)│
                               (logs)  │            │                     │
                                       │   bridgev2.Bridge × 3            │
                                       │    ├─ mautrix-whatsapp connector │
                                       │    ├─ mautrix-meta connector     │
                                       │    └─ mautrix-meta igconnector   │
                                       └──────────────────────────────────┘
```

### 3.1 Repository layout

```
truki-bridge/
  go.mod                      module github.com/<owner>/truki-desktop/truki-bridge
  PROTOCOL.md                 versioned RPC contract (source of truth)
  cmd/truki-bridge/main.go    entry point; `--version`, `devcli` subcommand
  internal/rpc/               framing, dispatch, event push
  internal/trukiconnector/    MatrixConnector + MatrixAPI implementation
  internal/store/             SQLCipher open/keying, chat + event tables, FTS
  internal/login/             drives bridgev2.LoginProcess state machines
  internal/networks/          registry: which connectors are compiled in
  internal/faketest/          fake NetworkConnector for end-to-end tests
```

The folder name contains `truki`, satisfying the naming convention. Go files
inside carry the Truki copyright header.

## 4. Inside truki-bridge

### 4.1 Bridge instances

bridgev2 runs one `NetworkConnector` per `bridgev2.Bridge`. `truki-bridge`
creates one `Bridge` per enabled network, all in one process, all sharing one
database. bridgev2 already separates tables by bridge ID, so they do not
collide.

Networks compiled into v1:

| Network ID  | Package                                   | Login flows exposed           |
|-------------|-------------------------------------------|-------------------------------|
| `whatsapp`  | `go.mau.fi/mautrix-whatsapp/pkg/connector`| `qr`, `phone` (pairing code)  |
| `meta`      | `go.mau.fi/mautrix-meta/pkg/connector`    | `facebook`, `messenger` (cookies) |
| `instagram` | `go.mau.fi/mautrix-meta/pkg/igconnector`  | `instagram` (cookies)         |

The Messenger Lite flows (`messenger-lite`, `messenger-lite-android`) and the
Instagram password flows (`android`, `instagram-password`) are not
shown in v1; they can be enabled later without protocol changes.

A Bridge is only constructed when its network has a logged-in account or a
login in progress, so unused connectors cost nothing at runtime.

### 4.2 The Truki connector

`internal/trukiconnector` implements `bridgev2.MatrixConnector` and
`bridgev2.MatrixAPI`, plus `MatrixConnectorWithNotifications`. It is the only
component with substantial new logic.

| bridgev2 call                    | Truki connector behaviour |
|----------------------------------|---------------------------|
| `CreateRoom`                     | Insert a `chat` row; return a local room ID `!<uuid>:truki.local` |
| `SendMessage` / `SendState`      | Insert an `event` row; push `event.message` / `event.chat` |
| `BatchSend`                      | Insert events in one transaction (backfill); push one `event.chat` |
| `UploadMedia(Stream)`            | Write file to `<dataDir>/media/<sha256>`; return `mxc://truki.local/<id>` |
| `DownloadMedia(ToFile)`          | Read that file back |
| `GenerateContentURI` / `ParseContentURI` | Deterministic mapping for direct media |
| `FormatGhostMXID` / `ParseGhostMXID` | `@<network>_<escaped id>:truki.local` |
| `GenerateDeterministic*ID`       | Hash-based, stable across restarts |
| `MarkRead`, `MarkUnread`, `MarkTyping`, `TagRoom`, `MuteRoom` | Update `chat` row; push event |
| `GetMembers`, `GetMemberInfo`, `GetPowerLevels` | Served from a `member` table populated by state events |
| `SendBridgeStatus`               | Push `event.accountState` |
| `SendMessageStatus`              | Update event status; push `event.message` with `status` |
| `DisplayNotification`            | Push `event.notify` |
| `ServerName`                     | `truki.local` |

There is exactly one local Matrix user, `@me:truki.local`, configured as the
bridge admin and the owner of every login.

**Outgoing messages** from Truki are turned into Matrix-shaped `event.Event`
values and passed to `bridge.QueueMatrixEvent`. This is the same path a real
homeserver uses, so every connector's send logic runs unmodified.

**Message format.** Event content is stored as the Matrix JSON the bridges
already produce (`body`, `format`/`formatted_body`, `m.relates_to`, media
info). The bridge does not translate to a new format. The Inbox renderer in
sub-project 2 owns that translation.

### 4.3 Storage

- One file, `<userData>/truki-bridge/truki-bridge.db`, opened with SQLCipher.
- Driver: `github.com/mattn/go-sqlite3` with the `libsqlite3` build tag,
  linked against SQLCipher. `PRAGMA key` is issued before any other statement.
- Key: 32 random bytes, delivered in the `init` request over stdin. Never on
  the command line, never in an environment variable, never logged.
- Tables owned by the Truki connector: `chat`, `event`, `member`,
  `event_fts` (FTS5 over message bodies). bridgev2's own tables live in the
  same file.
- Truki-owned migrations use mautrix-go's `dbutil` upgrade table, scoped to
  the Truki connector. They have nothing to do with Signal's
  `SCHEMA_VERSIONS`.
- Media lives unencrypted on disk under `<userData>/truki-bridge/media/` in
  v1, matching the bridges' own behaviour. Encrypting media at rest is
  noted as a follow-up, not v1 scope.

### 4.4 Login

`internal/login` calls `NetworkConnector.GetLoginFlows` and `CreateLogin`
directly and steps through `bridgev2.LoginProcess`. Each step is forwarded
to Truki as `event.login.step` carrying the step type (`user_input`,
`cookies`, `display_and_wait`, `complete`) and its parameters unchanged. The
UI in sub-project 3 renders them. In this sub-project, `devcli` renders them
in a terminal (QR as text, cookie prompt).

## 5. RPC protocol

Newline-delimited JSON-RPC 2.0 on stdin/stdout. stderr carries structured
logs, which the supervisor forwards to Truki's logger. `PROTOCOL.md` is the
versioned contract; this section is its summary.

### 5.1 Handshake

1. Supervisor spawns the process.
2. Supervisor sends `init {protocolVersion, dataDir, dbKey}`.
3. Bridge replies `{protocolVersion, bridgeVersion, networks: [{id, name}]}`.
4. Any request before `init` returns `NOT_INITIALIZED`. A major protocol
   mismatch makes the supervisor stop the bridge and report
   `BRIDGE_INCOMPATIBLE`.

### 5.2 Requests (Truki → bridge)

| Method | Params | Result |
|--------|--------|--------|
| `networks.list` | — | networks and whether each is enabled |
| `accounts.list` | — | logins with network, remote name, state |
| `accounts.logout` | `loginId` | — |
| `login.flows` | `network` | flow list |
| `login.start` | `network, flowId` | `processId` + first step |
| `login.submit` | `processId, stepId, input?/cookies?` | next step |
| `login.cancel` | `processId` | — |
| `chats.list` | `cursor?, limit` | chats ordered by last activity |
| `chats.get` | `chatId` | one chat with members |
| `chats.markRead` | `chatId, eventId` | — |
| `chats.setMuted` | `chatId, until?` | — |
| `messages.list` | `chatId, before?, limit` | events, newest first |
| `messages.send` | `chatId, text, html?, replyTo?, attachments?` | local `eventId` (status `pending`) |
| `messages.react` | `chatId, eventId, key` | — |
| `messages.redact` | `chatId, eventId` | — |
| `media.path` | `mediaId` | absolute local path |
| `search` | `query, limit` | matching events |
| `shutdown` | — | — (process exits after flush) |

### 5.3 Events (bridge → Truki)

JSON-RPC notifications (no `id`):

- `event.message` — new, edited, redacted, or status change (`pending`,
  `sent`, `failed`).
- `event.chat` — created, renamed, avatar, unread count, muted.
- `event.typing`, `event.receipt`.
- `event.accountState` — `CONNECTING`, `CONNECTED`, `TRANSIENT_DISCONNECT`,
  `BAD_CREDENTIALS`, `LOGGED_OUT`, `UNKNOWN_ERROR` (bridgev2 state names).
- `event.notify` — sender, chat, preview text, for desktop notifications.
- `event.login.step` — next login step, e.g. a refreshed WhatsApp QR code.

### 5.4 Errors

JSON-RPC error objects with a stable string in `data.code`:
`NOT_INITIALIZED`, `NOT_LOGGED_IN`, `NETWORK_UNAVAILABLE`, `RATE_LIMITED`,
`INVALID_INPUT`, `NOT_FOUND`, `INTERNAL`. A failed send also produces an
`event.message` with `status: failed` and the error code.

`RATE_LIMITED` is surfaced, never retried automatically, to keep ban risk
down.

## 6. Truki Desktop side

### 6.1 TrukiBridgeSupervisor

New file `app/truki/TrukiBridgeSupervisor.main.ts`.

- **Lazy start.** Spawns `truki-bridge.exe` only when at least one network
  is enabled (a Truki setting, default none).
- **Key.** Generated once, wrapped with Electron `safeStorage`, stored as
  `<userData>/truki-bridge/truki-bridge.key`. If `safeStorage` is unavailable
  the bridge does not start and the reason is reported; it never falls back
  to an unencrypted database.
- **Restart policy.** On unexpected exit: backoff 1s, 2s, 4s … capped at
  60s. Five crashes within ten minutes stops restarts and reports
  `BRIDGE_STOPPED` until the user restarts it.
- **Shutdown.** On app quit: `shutdown`, wait up to 5s, then kill.
- **In-flight requests** fail with `BRIDGE_UNAVAILABLE` when the process
  dies. Unconfirmed outgoing messages are retried by bridgev2's own queue on
  restart.
- **IPC.** Registers `truki-bridge:request` (invoke) and
  `truki-bridge:event` (push) channels, and the `truki-media:` protocol that
  serves files resolved via `media.path`. All registration lives in this file.

### 6.2 Upstream edits (complete list for this sub-project)

| File | Change |
|------|--------|
| `app/main.main.ts` | One import and one `startTrukiBridgeSupervisor()` call. If `app/trukiAppName.main.ts` exists on the branch, it stays the first import. |
| `package.json` | `truki-bridge.exe` added to `build.extraResources`; new `build:truki-bridge` script. |

No renderer, SQL, protobuf or Redux changes in this sub-project.

## 7. Build and release

- `pnpm run build:truki-bridge` runs `go build` for `windows/amd64` with
  `CGO_ENABLED=1`. On Linux it cross-compiles with `x86_64-w64-mingw32-gcc`
  against a SQLCipher build for mingw; on Windows it uses a local mingw.
  Output: `build/truki-bridge/truki-bridge.exe`.
- The SQLCipher + cgo + Windows build is the riskiest step. The
  implementation plan proves it **first**, before connector work.
- `scripts/truki-sign-windows.mjs` signs `truki-bridge.exe` along with
  Truki's own binaries, so SmartScreen and antivirus do not flag an unsigned
  helper.
- Bridge updates ship inside normal Truki releases through the existing
  auto-updater. No separate updater.
- mautrix dependency updates: `go get -u` the three modules, rebuild, run the
  tests. If the modules require different `maunium.net/go/mautrix` versions,
  the build fails until they align; the fallback is pinning the older
  connector's module to a newer commit.

## 8. Testing

### 8.1 Go (`go test ./...`)

- **trukiconnector:** each method against a temporary SQLCipher database —
  room creation, event persistence, media URI round-trip, ghost IDs, paging
  order, FTS search.
- **End-to-end with a fake network:** `internal/faketest` implements a
  `NetworkConnector` with scripted login, incoming messages and a recorded
  send log. Tests drive the real RPC layer: log in → receive →
  `event.message` → `messages.send` → fake network received it; plus edits,
  reactions, redactions and failed sends.
- **RPC:** malformed JSON, unknown method, missing `init`, version mismatch.
- **Encryption:** database unreadable without the key, readable with it.
- **Windows binary:** CI cross-compiles and runs `truki-bridge.exe --version`
  (Wine or a Windows runner).

### 8.2 Truki (`pnpm run test-node`)

`ts/test-node/truki/TrukiBridgeSupervisor_test.node.ts` runs the supervisor
against a fake bridge (a small Node script speaking the protocol): lazy
start, handshake, request/response, event forwarding, restart backoff,
give-up after repeated crashes, clean shutdown, in-flight failure.

AGENTS.md verification must stay at baseline: `check:types` 2 errors,
`oxlint` 12 errors, `test-node` passing with 12 pending.

### 8.3 Manual

With real accounts, via `truki-bridge devcli`: WhatsApp QR login,
Messenger cookie login, receive and send in both. This proves the real
connectors before any UI exists.

## 9. Out of scope

- Inbox UI and Spaces integration (sub-project 2).
- Login screens and cookie-capture window (sub-project 3).
- Networks beyond WhatsApp, Messenger/Facebook, Instagram; Linux and macOS
  builds (sub-project 4).
- Encrypting media files at rest.
- Running bridges on a remote server.

## 10. Risks

| Risk | Mitigation |
|------|-----------|
| Accounts suspended by Meta/WhatsApp | Off by default, explicit warning, no automatic retries on rate limits |
| mautrix-go changes `MatrixConnector`/`MatrixAPI` | Interface code isolated in `trukiconnector`; CI builds against latest |
| Connectors require different mautrix-go versions | Build fails loudly; pin older connector to a newer commit |
| cgo + SQLCipher on Windows | Proved first in the plan |
| bridgev2 assumes a real homeserver somewhere not covered by the interface | Found by the fake-network end-to-end test before real networks are wired |
| Unsigned helper flagged by antivirus | Signed with Truki's certificate |
