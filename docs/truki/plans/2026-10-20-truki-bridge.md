# Truki Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not start a task before the previous one's tests pass and are committed.

**Goal:** Ship `truki-bridge.exe`, a Go child process that runs the mautrix WhatsApp, Meta and Instagram network connectors against Truki's own local storage, plus the Truki main-process supervisor that starts it and talks to it over stdio JSON-RPC.

**Architecture:** One `bridgev2.Bridge` per network, all sharing one SQLCipher database, all using a Truki-owned `MatrixConnector` that writes rooms/events to local tables instead of a homeserver. Truki's main process spawns the binary lazily, hands it a `safeStorage`-wrapped key over stdin, and relays requests/events to the renderer over two IPC channels. No UI in this sub-project.

**Tech Stack:** Go 1.27 (`~/.local/go/bin`), `maunium.net/go/mautrix` v0.32.0 `bridgev2`, `go.mau.fi/util` v0.11.0 `dbutil`, `github.com/mattn/go-sqlite3` (`libsqlite3` tag) linked against SQLCipher + libtomcrypt, mingw-w64; TypeScript, Electron, electron-mocha + chai.

**Spec:** `docs/truki/specs/2026-10-20-truki-bridge-design.md` — read it before starting. This plan argues from it; section numbers below (§) refer to it.

## Global Constraints

- **Every upstream edit is additive**, and this sub-project edits exactly two upstream files: `app/main.main.ts` (one import, one call) and `package.json` (`extraResources` entry, `build:truki-bridge` script). §6.2.
- **Never add to `SCHEMA_VERSIONS`.** The bridge's tables live in its own SQLCipher file and use `dbutil` upgrade tables, unrelated to Signal's migrations.
- **mautrix modules are dependencies, never forked or edited.** No `replace` directives pointing at local copies. §2.
- **Every Truki-owned file has `truki` in its path or name** and carries `// Copyright 2026 Truki` / `// SPDX-License-Identifier: AGPL-3.0-only`. Everything under `truki-bridge/` satisfies the path rule.
- **The DB key is never on argv, in env, or in logs.** It arrives only in the `init` request. §4.3.
- **No unencrypted fallback.** If `safeStorage` or SQLCipher keying fails, the bridge does not start. §6.1.
- **IPC/protocol names are `truki`-prefixed:** `truki-bridge:request`, `truki-bridge:event`, `truki-media:`.
- **Protocol version is `1`.** Server name is `truki.local`; local user is `@me:truki.local`. Network IDs: `whatsapp`, `meta`, `instagram`. §4.1.
- **Login flows shown in v1:** `whatsapp`: `qr`, `phone`; `meta`: `facebook`, `messenger`; `instagram`: `instagram`. All others filtered out. §4.1.
- **Error codes** (in JSON-RPC `error.data.code`): `NOT_INITIALIZED`, `NOT_LOGGED_IN`, `NETWORK_UNAVAILABLE`, `RATE_LIMITED`, `INVALID_INPUT`, `NOT_FOUND`, `INTERNAL`; supervisor-side: `BRIDGE_UNAVAILABLE`, `BRIDGE_INCOMPATIBLE`, `BRIDGE_STOPPED`. §5.4, §6.1.
- **Restart policy:** backoff 1s, 2s, 4s… capped at 60s; 5 crashes within 10 minutes → stop, `BRIDGE_STOPPED`. Shutdown grace 5s. §6.1.
- **Truki verification baseline** (AGENTS.md): `check:types` exactly 2 errors, `oxlint` exactly 12 errors, `test-node` all passing with 12 pending. Quote each summary line literally.
- Go commands in this plan assume `export PATH=$HOME/.local/go/bin:$PATH` and are run from `truki-bridge/` unless stated.

## Review Focus

1. **A library writes to stdout** (whatsmeow, a connector, a panic trace) — the RPC stream must not be corrupted. Expect: `main` dups the real stdout for RPC and points `os.Stdout` at stderr before anything else runs. Test in Task 3.
2. **A single message line larger than 64 KiB** (long text, big HTML, backfill batch event) — `bufio.Scanner`'s default limit would kill the reader. Expect: lines up to 16 MiB accepted; larger lines produce `INVALID_INPUT` and the reader continues. Test in Task 3.
3. **Bridge killed during backfill, then restarted** — the same remote messages arrive again. Expect: no duplicate `event` rows (deterministic event IDs, upsert). Test in Task 5.
4. **`media.path` called with a crafted ID** (`../../truki-bridge.key`, absolute path, mxc of another server) — Expect: `NOT_FOUND`/`INVALID_INPUT`, never a path outside `<dataDir>/media/`. Test in Task 8; the `truki-media:` handler re-checks in Task 10.
5. **User is slow on the WhatsApp QR step** — the connector refreshes the QR and eventually times out. Expect: each refresh produces a new `event.login.step`; timeout produces a step-level error, the process is cleaned up, and `login.start` works again. Test in Task 7 with the fake network.

---

## File Map

```
truki-bridge/
  go.mod, go.sum
  PROTOCOL.md                                 Task 3, extended in 6–8
  scripts/build-sqlcipher.sh                  Task 1
  scripts/build.sh                            Task 1
  cmd/truki-bridge/main.go                    Task 1, 3, 9
  cmd/truki-bridge/devcli.go                  Task 9
  internal/store/open.go                      Task 1   Open(path, key) (*dbutil.Database, error)
  internal/store/schema.go, upgrades/*.sql    Task 2
  internal/store/chats.go, events.go, members.go, search.go   Task 2
  internal/rpc/conn.go, dispatch.go, errors.go                Task 3
  internal/trukiconnector/connector.go        Task 4   MatrixConnector
  internal/trukiconnector/intent.go           Task 4   MatrixAPI
  internal/trukiconnector/ids.go, media.go    Task 4
  internal/host/host.go                       Task 5   one Bridge per network
  internal/host/config.go                     Task 5   network config from example YAML
  internal/host/outgoing.go                   Task 6
  internal/login/login.go                     Task 7
  internal/api/handlers.go                    Task 6–8 RPC method → host/store
  internal/networks/networks.go               Task 9   real connector registry
  internal/faketest/fakenetwork.go            Task 5
app/truki/TrukiBridgeSupervisor.main.ts       Task 10
app/truki/trukiBridgeProtocol.std.ts          Task 10  shared request/event types
ts/test-node/truki/TrukiBridgeSupervisor_test.main.ts       Task 10  (spec §8.2 says .node.ts; .main.ts because it imports a .main.ts file — use whatever suffix lint demands)
ts/test-node/truki/fixtures/fakeTrukiBridge.mjs             Task 10
scripts/truki-build-bridge.mjs                Task 11
app/main.main.ts, package.json, scripts/truki-sign-windows.mjs   Task 11
```

---

### Task 1: Module scaffold and the SQLCipher/Windows build proof

This is the riskiest step (§7). If it cannot be made to work, **stop and report** — do not swap in unencrypted SQLite or a different driver.

**Files:**
- Create: `truki-bridge/go.mod`, `truki-bridge/cmd/truki-bridge/main.go`, `truki-bridge/internal/store/open.go`, `truki-bridge/internal/store/open_test.go`, `truki-bridge/scripts/build-sqlcipher.sh`, `truki-bridge/scripts/build.sh`, `truki-bridge/.gitignore` (`/third_party/build/`, `/dist/`)

**Interfaces:**
- Produces: `store.Open(path string, key []byte) (*dbutil.Database, error)`; `store.ErrBadKey`; `main.Version` (set by `-ldflags -X`); build script outputs `third_party/build/<goos>-<goarch>/{include,lib}` and `dist/<goos>-<goarch>/truki-bridge[.exe]`.

- [ ] **Step 1: Toolchain.** Install cross tools: `sudo apt-get install -y gcc-mingw-w64-x86-64 tcl make` (tcl is needed by SQLCipher's amalgamation build). Verify `x86_64-w64-mingw32-gcc --version` prints a version.

- [ ] **Step 2: `go.mod`.** `go mod init github.com/August-Roosi/truki-desktop/truki-bridge`, then `go get maunium.net/go/mautrix@v0.32.0 go.mau.fi/util@v0.11.0 github.com/mattn/go-sqlite3`.

- [ ] **Step 3: `scripts/build-sqlcipher.sh <linux-amd64|windows-amd64>`.** Downloads pinned SQLCipher (latest 4.x tag at time of writing; record version + SHA-256 in the script and verify with `sha256sum -c`) and pinned libtomcrypt; builds both as **static** libraries for the target (`CC=x86_64-w64-mingw32-gcc` for Windows) with `CFLAGS=-DSQLITE_HAS_CODEC -DSQLCIPHER_CRYPTO_LIBTOMCRYPT -DSQLITE_ENABLE_FTS5 -DSQLITE_TEMP_STORE=2 -DSQLITE_ENABLE_COLUMN_METADATA`, installs headers and `libsqlcipher.a` + `libtomcrypt.a` into `third_party/build/<target>/`. Idempotent: skips if the outputs exist.

- [ ] **Step 4: `scripts/build.sh <target>`.** Runs build-sqlcipher for the target, then `CGO_ENABLED=1 go build -tags libsqlite3,sqlite_fts5 -ldflags "-X main.Version=$(git describe --always)"` with `CGO_CFLAGS=-I…/include/sqlcipher` and `CGO_LDFLAGS=-L…/lib -lsqlcipher -ltomcrypt` (`-static` added for Windows), writing to `dist/<target>/`.

- [ ] **Step 5: Failing tests** in `internal/store/open_test.go`:
  - `TestOpenCreatesEncryptedFile`: `Open(tmp, key32)`, create table, insert row, close; first 16 bytes of the file are **not** `"SQLite format 3\x00"`.
  - `TestOpenWrongKey`: reopen with a different key → `errors.Is(err, ErrBadKey)`.
  - `TestOpenRightKey`: reopen with the same key → row readable.
  - `TestCipherVersion`: `PRAGMA cipher_version` returns a non-empty string (proves SQLCipher, not plain SQLite, is linked).
  - `TestFTS5Available`: `CREATE VIRTUAL TABLE t USING fts5(x)` succeeds.

- [ ] **Step 6: Run, expect failure.** `CGO_CFLAGS=… CGO_LDFLAGS=… go test -tags libsqlite3,sqlite_fts5 ./internal/store/` → FAIL (`Open` undefined). Add a `scripts/test.sh` wrapper that sets the linux-amd64 cgo flags, and use it from here on.

- [ ] **Step 7: Implement `store.Open`.** Register a driver `truki-sqlcipher` (a `sqlite3.SQLiteDriver` whose `ConnectHook` runs `PRAGMA key = "x'<hex>'"` then `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, `PRAGMA busy_timeout = 5000`), open with `dbutil.NewWithDialect(path+"?_txlock=immediate", "truki-sqlcipher")` — check `NewWithDialect` maps unknown driver names to the SQLite dialect; if not, use `sql.Open` + `dbutil.NewWithDB(db, "sqlite3")`. Set `MaxOpenConns(1)`. Validate the key by running `SELECT count(*) FROM sqlite_master`; map `SQLITE_NOTADB` to `ErrBadKey`.

- [ ] **Step 8: Run, expect pass.** `scripts/test.sh ./internal/store/` → `ok`.

- [ ] **Step 9: `main.go` minimal.** `--version` prints `truki-bridge <Version>` and exits 0. Copyright header.

- [ ] **Step 10: Prove the Windows binary.** `scripts/build.sh windows-amd64` succeeds; `file dist/windows-amd64/truki-bridge.exe` reports `PE32+ executable`; `wine dist/windows-amd64/truki-bridge.exe --version` (install `wine` via apt if absent) prints the version. Also add a hidden `--selftest-db <dir>` flag that runs the five store checks from Step 5 in-process and exits 0/1; run it under wine → exit 0. Paste the output into the task report.

- [ ] **Step 11: Commit.** `git add truki-bridge && git commit -m "truki(bridge): Go module, SQLCipher store and Windows build"`

---

### Task 2: Truki tables, upgrades and queries

**Files:**
- Create: `internal/store/schema.go`, `internal/store/upgrades/00-latest.sql`, `internal/store/chats.go`, `events.go`, `members.go`, `search.go`, `store_test.go`

**Interfaces:**
- Consumes: `store.Open`.
- Produces:
  ```go
  type Store struct{ DB *dbutil.Database }
  func New(db *dbutil.Database) *Store
  func (s *Store) Upgrade(ctx) error             // own upgrade table "truki_version"
  type Chat struct { ID id.RoomID; Network string; LoginID string; PortalID string;
      Name, Topic string; AvatarMXC id.ContentURIString; IsDM bool;
      UnreadCount int; MutedUntil time.Time; LastActivity time.Time; LastEventID id.EventID }
  type Event struct { ID id.EventID; RoomID id.RoomID; Sender id.UserID; Type string;
      StateKey *string; Content json.RawMessage; Timestamp time.Time; StreamOrder int64;
      Status string /* pending|sent|failed|"" */; ErrorCode string; Redacted bool;
      RelatesTo id.EventID; RelType string }
  func (s *Store) PutChat(ctx, *Chat) error                  // upsert by ID
  func (s *Store) GetChat(ctx, id.RoomID) (*Chat, error)     // nil,nil if missing
  func (s *Store) ListChats(ctx, cursor string, limit int) ([]*Chat, string /*next*/, error)
  func (s *Store) PutEvent(ctx, *Event) (inserted bool, err error)  // upsert by ID; inserted=false on duplicate
  func (s *Store) PutEvents(ctx, []*Event) error                    // one transaction
  func (s *Store) GetEvent(ctx, id.EventID) (*Event, error)
  func (s *Store) ListEvents(ctx, room id.RoomID, before int64 /*stream order, 0=latest*/, limit int) ([]*Event, error) // newest first
  func (s *Store) SetEventStatus(ctx, id.EventID, status, errCode string) error
  func (s *Store) PutMember(ctx, room id.RoomID, user id.UserID, content *event.MemberEventContent) error
  func (s *Store) GetMembers(ctx, room id.RoomID) (map[id.UserID]*event.MemberEventContent, error)
  func (s *Store) Search(ctx, query string, limit int) ([]*Event, error)
  ```

- [ ] **Step 1: Failing tests** (`store_test.go`, all on a temp encrypted DB):
  - `TestUpgradeIdempotent`: `Upgrade` twice → no error; tables `chat`, `event`, `member`, `event_fts` exist.
  - `TestPutEventDedup`: `PutEvent` same ID twice → `inserted` true then false; one row.
  - `TestListEventsPaging`: 25 events with stream orders 1..25; `ListEvents(room, 0, 10)` → orders 25..16; `ListEvents(room, 16, 10)` → 15..6.
  - `TestListChatsOrderAndCursor`: 3 chats with different `LastActivity` → newest first; cursor pages without overlap.
  - `TestSearchFTS`: event bodies `"tere hommikust"`, `"good morning 🌅"`; `Search("hommikust")` → first; `Search("morning")` → second; `Search("\"unbalanced")` → error is `INVALID_INPUT`-mappable (`store.ErrBadQuery`), not a panic.
  - `TestRedactedEventLeavesFTS`: mark redacted → no longer returned by `Search`.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `event_fts` is an external-content FTS5 table over `event(content->>'body')` kept in sync with triggers. `StreamOrder` is assigned by the store as `max+1` per room on insert unless provided. Queries use `dbutil.QueryHelper` like mautrix code does.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `truki(bridge): local chat, event and member store`.

---

### Task 3: JSON-RPC transport and handshake

**Files:**
- Create: `internal/rpc/conn.go`, `dispatch.go`, `errors.go`, `rpc_test.go`; `PROTOCOL.md`
- Modify: `cmd/truki-bridge/main.go`

**Interfaces:**
- Produces:
  ```go
  const ProtocolVersion = 1
  type Error struct{ Code string; Message string }   // implements error
  func Errf(code, format string, args ...any) *Error
  type Handler func(ctx context.Context, params json.RawMessage) (any, error)
  type Conn struct{ ... }
  func NewConn(r io.Reader, w io.Writer, log zerolog.Logger) *Conn
  func (c *Conn) Handle(method string, h Handler)
  func (c *Conn) Notify(method string, params any)    // goroutine-safe, never blocks callers longer than the write
  func (c *Conn) Serve(ctx context.Context) error      // returns on EOF or ctx done
  ```
  Requests other than `init` before a successful `init` → `NOT_INITIALIZED`. Non-`*Error` handler errors → `INTERNAL` with message, logged.
  `init` params: `{protocolVersion int, dataDir string, dbKey string /*hex, 64 chars*/}`; result: `{protocolVersion, bridgeVersion, networks: [{id, name}]}`. A different `protocolVersion` → error `INVALID_INPUT` (supervisor maps to `BRIDGE_INCOMPATIBLE`).

- [ ] **Step 1: Failing tests** (`rpc_test.go`, using `io.Pipe`):
  - `TestRequestBeforeInit` → error code `NOT_INITIALIZED`.
  - `TestUnknownMethod` → JSON-RPC `-32601` with `data.code` `INVALID_INPUT`.
  - `TestMalformedLine`: write `{nope\n` then a valid request → first yields `-32700`, second is answered.
  - `TestLargeLine`: a 1 MiB `params.text` is accepted; a 17 MiB line yields `INVALID_INPUT` and the next request still works. (Review Focus 2)
  - `TestNotifyConcurrent`: 100 goroutines `Notify` → every output line is valid JSON.
  - `TestInitVersionMismatch` → `INVALID_INPUT`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with `bufio.Reader.ReadSlice`/`ReadBytes` and an explicit 16 MiB cap; writes serialized by a mutex, each message one line ending `\n`.
- [ ] **Step 4: Stdout guard in `main.go`.** Before any other initialization: `rpcOut := os.NewFile(dup(stdout))`, then `os.Stdout = os.Stderr` (and on Unix `dup2(2,1)`; on Windows `SetStdHandle(STD_OUTPUT_HANDLE, stderr)`) so stray writes land in logs. Logging is zerolog JSON to stderr. Test `TestStdoutGuard` (in `cmd/truki-bridge`, builds and runs the binary with a hidden `--test-print-stdout` flag that `fmt.Println`s garbage then serves): a client doing `init` still gets a valid response. (Review Focus 1)
- [ ] **Step 5: Run, expect PASS.**
- [ ] **Step 6: `PROTOCOL.md`** — framing, handshake, error object, codes. Methods are added in later tasks as they land.
- [ ] **Step 7: Commit** `truki(bridge): stdio JSON-RPC transport and handshake`.

---

### Task 4: Truki MatrixConnector and MatrixAPI

**Files:**
- Create: `internal/trukiconnector/connector.go`, `intent.go`, `ids.go`, `media.go`, `connector_test.go`

**Interfaces:**
- Consumes: `store.Store`, `rpc.Conn.Notify` (via the `Sink` below, so tests need no RPC).
- Produces:
  ```go
  type Sink interface {
      Message(ev *store.Event)                       // → event.message
      Chat(c *store.Chat)                            // → event.chat
      AccountState(network string, st status.BridgeState) // → event.accountState
      Notify(network string, d *bridgev2.DirectNotificationData)
      Typing(room id.RoomID, users []id.UserID); Receipt(room id.RoomID, user id.UserID, ev id.EventID)
  }
  const ServerName = "truki.local"; var LocalUser = id.UserID("@me:truki.local")
  func New(network string, st *store.Store, mediaDir string, sink Sink) *Connector
  // *Connector implements bridgev2.MatrixConnector, MatrixConnectorWithNotifications, and provides BotIntent().
  ```
  Behaviour table: spec §4.2. Ghost MXIDs: `@<network>_<QueryEscape-style id>:truki.local` (use `id.EncodeUserLocalpart`). Room IDs: `!<uuid>:truki.local`. Deterministic event IDs: `$` + base64url(sha256(roomID|portalKey|messageID|partID))[:43]. Media: `mxc://truki.local/<sha256 hex>`; file at `<mediaDir>/<sha256 hex>`. `GetCapabilities` returns `{AutoJoinInvites: true, BatchSending: true}` (check field names in v0.32.0 `MatrixCapabilities`). Bot intent = an intent for `@truki-bot:truki.local` whose sends are stored like any other.

- [ ] **Step 1: Failing tests** (`connector_test.go`; construct with a recording `Sink`):
  - `TestGhostIDRoundTrip`: `ParseGhostMXID(FormatGhostMXID("+372 5555/x"))` returns the input, `true`; an MXID from another network/server returns `false`.
  - `TestDeterministicIDsStable`: same inputs → same IDs across two `Connector` instances.
  - `TestCreateRoomAndSend`: `GhostIntent(u).CreateRoom` then `SendMessage(m.room.message, {body:"hi"})` → one chat and one event in the store; sink saw `Chat` then `Message`; event sender is the ghost MXID.
  - `TestSendMessageDuplicate`: `SendMessage` with `extra.Timestamp` and a deterministic ID used twice (via `BatchSend`) → one row, one sink call.
  - `TestUploadDownloadMedia`: upload bytes → `mxc://truki.local/<sha>`; `DownloadMedia` returns same bytes; `ParseContentURI` of an `mxc://evil.example/…` URI errors.
  - `TestMarkReadUpdatesUnread`: two incoming messages → `UnreadCount==2`; `MarkRead` by `LocalUser` intent on the latest → 0, sink got `Chat`.
  - `TestMemberStateServedBack`: `SendState(m.room.member)` for two users → `GetMembers` returns both.
  - `TestGhostTypingAndReceipt`: ghost intent `MarkTyping` → sink `Typing(room, [ghost])`; ghost `MarkRead` → sink `Receipt(room, ghost, ev)`.
  - `TestDisplayNotification`: `DisplayNotification` → sink `Notify` with the same data.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Methods not listed in §4.2 (`DeleteRoom`, `EnsureInvited`, `SetExtraProfileMeta`, `TagRoom`…) are implemented as no-ops or simple store updates — none may panic or return `not implemented` errors, because bridgev2 treats errors on these paths as fatal for the portal.
- [ ] **Step 4: Run, expect PASS.** Also `go vet ./...`.
- [ ] **Step 5: Commit** `truki(bridge): Truki MatrixConnector backed by the local store`.

---

### Task 5: Bridge host, fake network, and incoming messages end-to-end

**Files:**
- Create: `internal/host/host.go`, `internal/host/config.go`, `internal/faketest/fakenetwork.go`, `internal/host/host_test.go`

**Interfaces:**
- Consumes: `trukiconnector.New`, `store.Open/New`.
- Produces:
  ```go
  type NetworkDef struct { ID, Name string; New func() bridgev2.NetworkConnector; Flows []string /* allowed flow IDs */ }
  type Host struct { ... }
  func NewHost(db *dbutil.Database, st *store.Store, dataDir string, sink trukiconnector.Sink, defs []NetworkDef, log zerolog.Logger) *Host
  func (h *Host) Start(ctx) error            // starts only networks with existing logins
  func (h *Host) Bridge(ctx, network string) (*bridgev2.Bridge, error)  // lazily constructs + starts
  func (h *Host) Stop()
  // faketest:
  func NewFakeNetwork() *FakeNetwork          // implements NetworkConnector, LoginProcess (one "fake" flow: user_input "username" → complete), NetworkAPI
  func (f *FakeNetwork) Deliver(login networkid.UserLoginID, chat networkid.PortalID, msgID networkid.MessageID, text string)
  func (f *FakeNetwork) Sent() []FakeSent     // messages the bridge sent to the network
  ```
  Per-network `bridgev2.NewBridge(networkid.BridgeID(def.ID), db, log, cfg, trukiconnector.New(...), def.New(), commands.NewProcessor)`. `cfg` = `bridgeconfig.BridgeConfig` with `Permissions` granting `@me:truki.local` admin, `PersonalFilteringSpaces: false`, backfill enabled with connector defaults. Network config: `config.go` unmarshals the connector's `GetConfig()` example YAML into its `data` pointer (strip `$`-templated lines if any example uses them — check WhatsApp and Meta examples).

- [ ] **Step 1: Failing tests** (`host_test.go`):
  - `TestFakeLoginAndIncoming`: start host with fake def; log in via the fake `LoginProcess` directly; `Deliver(…, "tere")` → within 5s the recording sink has a `Chat` and a `Message` with `content.body == "tere"`; store has one chat with `Network == "fake"`.
  - `TestRestartNoDuplicates`: deliver 3 messages, `Stop`, new `Host` on the same DB, fake re-delivers the same 3 IDs (simulated backfill) → still 3 events. (Review Focus 3)
  - `TestLazyStart`: host with a def but no logins → `Start` does not call the connector's `Start` (fake counts calls).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** If bridgev2 needs something the Truki connector doesn't provide (management room, bot joins, double puppet), fix it in `trukiconnector` — this test is where §10's "bridgev2 assumes a homeserver" risk surfaces. Note each such finding in `PROTOCOL.md`'s implementation notes.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `truki(bridge): bridge host and fake-network end-to-end`.

---

### Task 6: Outgoing messages, reactions, redactions, read state

**Files:**
- Create: `internal/host/outgoing.go`, `internal/api/handlers.go`, `internal/api/handlers_test.go`
- Modify: `PROTOCOL.md`

**Interfaces:**
- Consumes: `Host.Bridge`, `bridge.QueueMatrixEvent`, `bridge.GetPortalByMXID`.
- Produces RPC methods (params → result), wired by `api.Register(conn *rpc.Conn, h *host.Host, st *store.Store)`:
  - `messages.send {chatId, text, html?, replyTo?, attachments?: [{path, name, mimeType}]}` → `{eventId}`; event stored immediately with `status: "pending"`, then `sent`/`failed` via `SendMessageStatus`.
  - `messages.react {chatId, eventId, key}` → `{eventId}`
  - `messages.redact {chatId, eventId}` → `{}`
  - `chats.markRead {chatId, eventId}` → `{}`; `chats.setMuted {chatId, until?: RFC3339}` → `{}`
  Outgoing events are `event.Event{Sender: LocalUser, RoomID, ID: "$truki-<uuid>", Type, Content}` passed to `QueueMatrixEvent`. Attachments: upload via the connector's media store first, then `m.image`/`m.file` content.

- [ ] **Step 1: Failing tests** (fake network, real RPC over pipes):
  - `TestSendText`: `messages.send` → result has `eventId`; fake `Sent()` contains the text; sink saw `Message` with `status "sent"`.
  - `TestSendFailure`: fake configured to fail the next send → `event.message` with `status "failed"` and an error code.
  - `TestSendUnknownChat` → `NOT_FOUND`.
  - `TestReply`: `replyTo` set → fake receives reply-to of the remote message ID.
  - `TestReactAndRedact`: fake records reaction and removal.
  - `TestMarkRead`: unread goes to 0; fake records a read receipt.
  - `TestSendAttachment`: temp PNG → fake receives a file with the same bytes.
  - `TestRateLimitedNotRetried`: fake returns a rate-limit error (`bridgev2.WrapErrorInStatus(...).WithErrorReason(event.MessageStatusTooManyRequests)` or the connector-equivalent; check v0.32.0) → `event.message` `status "failed"`, error code `RATE_LIMITED`; fake saw exactly one attempt.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `truki(bridge): outgoing messages over RPC`.

---

### Task 7: Login and accounts over RPC

**Files:**
- Create: `internal/login/login.go`, `internal/login/login_test.go`
- Modify: `internal/api/handlers.go`, `PROTOCOL.md`

**Interfaces:**
- Produces RPC methods:
  - `login.flows {network}` → `[{id, name, description}]` filtered to `NetworkDef.Flows`.
  - `login.start {network, flowId}` → `{processId, step}`; `login.submit {processId, stepId, input?: map, cookies?: map}` → `{step}`; `login.cancel {processId}` → `{}`.
  - `step` is bridgev2's `LoginStep` serialized as-is (`type`, `step_id`, `instructions`, `display_and_wait`, `user_input`, `cookies`, `complete`).
  - `display_and_wait` steps are followed by calling `Wait` in a goroutine; each new step (QR refresh, completion, error) is pushed as `event.login.step {processId, step}` or `{processId, error: {code, message}}`.
  - `accounts.list` → `[{loginId, network, remoteName, state}]`; `accounts.logout {loginId}` → `{}`.
  - Processes expire after 10 min idle; at most one in-flight process per network.

- [ ] **Step 1: Failing tests** (fake network extended with a `display_and_wait` flow that refreshes twice then completes, and a variant that times out):
  - `TestLoginUserInputFlow`: start → `user_input` step → submit `{username:"a"}` → `complete`; `accounts.list` has one login with state reaching `CONNECTED` (via `event.accountState`).
  - `TestLoginQRRefresh`: two `event.login.step` with different `display_and_wait.data`, then complete. (Review Focus 5)
  - `TestLoginTimeoutThenRestart`: timeout variant → `event.login.step` with `error`; a new `login.start` succeeds. (Review Focus 5)
  - `TestFlowFilter`: def allows only `fake` → hidden flows not listed; `login.start` with a hidden flow → `INVALID_INPUT`.
  - `TestLogout`: logout → login gone; `event.accountState` `LOGGED_OUT`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Logins are created for the `@me:truki.local` user via `bridge.GetUserByMXID`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `truki(bridge): login and account management over RPC`.

---

### Task 8: Read-side RPC: chats, messages, media, search, shutdown

**Files:**
- Modify: `internal/api/handlers.go`, `internal/api/handlers_test.go`, `cmd/truki-bridge/main.go`, `PROTOCOL.md`

**Interfaces:**
- Produces RPC methods: `networks.list` → `[{id, name, enabled /*has logins*/}]`; `chats.list {cursor?, limit≤200}` → `{chats, nextCursor}`; `chats.get {chatId}` → chat + `members`; `messages.list {chatId, before?, limit≤200}` → events newest first; `media.path {mediaId}` → `{path}`; `search {query, limit≤100}` → events; `shutdown` → `{}` then `Host.Stop()`, DB close, exit 0.
- `main.go` now: stdout guard → `rpc.NewConn` → on `init`: `store.Open(<dataDir>/truki-bridge.db, key)`, `Upgrade`, `host.NewHost(... networks.All() ...)`, `api.Register`, `host.Start`.

- [ ] **Step 1: Failing tests:**
  - `TestChatsListPaging`, `TestMessagesListPaging` — shapes and order as in Task 2.
  - `TestMediaPathTraversal`: `media.path` with `../../truki-bridge.key`, `/etc/passwd`, `mxc://evil.example/x`, `mxc://truki.local/../x` → `INVALID_INPUT`/`NOT_FOUND`; a real uploaded ID → path inside `<dataDir>/media/`. (Review Focus 4)
  - `TestSearchBadQuery` → `INVALID_INPUT`.
  - `TestShutdown` (binary-level, builds `cmd/truki-bridge` with fake networks via a `faketest` build tag): `init` → `shutdown` → process exits 0 within 5s.
  - `TestInitWrongKeyFails` (binary-level): second run on the same dataDir with a different key → `init` error `INTERNAL`, message contains `bad key`, then the process exits 1 (the supervisor treats it as a crash).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Full suite: `scripts/test.sh ./...` → all `ok`.
- [ ] **Step 5: Commit** `truki(bridge): read-side RPC and process lifecycle`.

---

### Task 9: Real networks and the dev CLI

**Files:**
- Create: `internal/networks/networks.go`, `cmd/truki-bridge/devcli.go`
- Modify: `go.mod`, `go.sum`, `cmd/truki-bridge/main.go`

**Interfaces:**
- Produces: `networks.All() []host.NetworkDef` with exactly:
  `{whatsapp, "WhatsApp", connector.WhatsAppConnector, flows [qr phone]}`, `{meta, "Facebook Messenger", connector.MetaConnector, flows [facebook messenger]}`, `{instagram, "Instagram", igconnector.InstagramConnector, flows [instagram]}` (check exported constructor/type names in each package).
- `truki-bridge devcli --data <dir>`: spawns itself as a child in RPC mode, sends `init` with a key from `<dir>/devcli.key` (created on first run), then a REPL: `flows <net>`, `login <net> <flow>` (renders QR in the terminal with `github.com/mdp/qrterminal/v3`, prompts for inputs/cookies), `accounts`, `chats`, `msgs <chatId>`, `send <chatId> <text>`, `search <q>`; prints every event line.

- [ ] **Step 1: Add dependencies.** `go get go.mau.fi/mautrix-whatsapp@latest go.mau.fi/mautrix-meta@latest`. Then `go list -m maunium.net/go/mautrix` must print `v0.32.0`; if MVS picked a newer version, run the full test suite — if Task 4's connector no longer compiles, adapt it (the interface is ours to keep up with). If the two modules cannot be satisfied together, stop and report.
- [ ] **Step 2: Failing test** `TestAllNetworks` (`networks_test.go`): `All()` returns the three IDs in order; each `New()` returns a non-nil connector whose `GetLoginFlows()` contains every ID in its `Flows`.
- [ ] **Step 3: Run, expect FAIL. Implement. Run, expect PASS.**
- [ ] **Step 4: Build both targets.** `scripts/build.sh linux-amd64` and `scripts/build.sh windows-amd64` succeed; `wine …/truki-bridge.exe --version` works.
- [ ] **Step 5: Commit** `truki(bridge): WhatsApp, Meta and Instagram connectors and devcli`.

---

### Task 10: TrukiBridgeSupervisor (Truki main process)

**Files:**
- Create: `app/truki/trukiBridgeProtocol.std.ts`, `app/truki/TrukiBridgeSupervisor.main.ts`, `ts/test-node/truki/TrukiBridgeSupervisor_test.main.ts`, `ts/test-node/truki/fixtures/fakeTrukiBridge.mjs`

**Interfaces:**
- Produces:
  ```ts
  // trukiBridgeProtocol.std.ts
  export const TRUKI_BRIDGE_PROTOCOL_VERSION = 1;
  export type TrukiBridgeErrorCode = 'NOT_INITIALIZED' | 'NOT_LOGGED_IN' | 'NETWORK_UNAVAILABLE' | 'RATE_LIMITED' | 'INVALID_INPUT' | 'NOT_FOUND' | 'INTERNAL' | 'BRIDGE_UNAVAILABLE' | 'BRIDGE_INCOMPATIBLE' | 'BRIDGE_STOPPED';
  export class TrukiBridgeError extends Error { code: TrukiBridgeErrorCode }
  export type TrukiBridgeEvent = { method: `event.${string}`; params: unknown };

  // TrukiBridgeSupervisor.main.ts
  export type TrukiBridgeSupervisorOptions = {
    binaryPath: string; userDataPath: string;
    encryptKey: (plain: string) => Buffer; decryptKey: (enc: Buffer) => string; isEncryptionAvailable: () => boolean;
    onEvent: (e: TrukiBridgeEvent) => void;
    spawnFn?: typeof spawn; now?: () => number; setTimeoutFn?: typeof setTimeout;  // test seams
  };
  export class TrukiBridgeSupervisor {
    constructor(opts: TrukiBridgeSupervisorOptions);
    getEnabledNetworks(): ReadonlyArray<string>;
    setEnabledNetworks(ids: ReadonlyArray<string>): Promise<void>; // persists <userData>/truki-bridge/settings.json; starts/stops lazily
    request<T>(method: string, params?: unknown): Promise<T>;       // rejects TrukiBridgeError
    shutdown(): Promise<void>;
    readonly state: 'stopped' | 'starting' | 'running' | 'backoff' | 'gave-up';
  }
  export function startTrukiBridgeSupervisor(getMainWindow: () => BrowserWindow | undefined): TrukiBridgeSupervisor;
  ```
  `startTrukiBridgeSupervisor` wires real Electron pieces: `binaryPath` = `join(process.resourcesPath, 'truki-bridge.exe')` when packaged, else `truki-bridge/dist/<platform>-<arch>/truki-bridge[.exe]`; `safeStorage` for the key; `ipcMain.handle('truki-bridge:request', …)`, `ipcMain.handle('truki-bridge:set-enabled-networks', …)`; events → `getMainWindow()?.webContents.send('truki-bridge:event', e)`; `protocol.handle('truki-media', …)` resolving via `media.path` and re-checking the result is under `<userData>/truki-bridge/media/`; `app.on('will-quit')` → `shutdown()`. stderr lines go to `createLogger('TrukiBridge')`.
  The key file is `<userData>/truki-bridge/truki-bridge.key` holding `encryptKey(hex32bytes)`.

- [ ] **Step 1: Fake bridge fixture** `fakeTrukiBridge.mjs`: reads newline JSON-RPC; answers `init` (`protocolVersion` from env `FAKE_PROTOCOL` default 1), echoes `echo`, emits `event.test` on `emit`, `crash` → `process.exit(3)`, `hang` → never answers, `shutdown` → exit 0; env `FAKE_CRASH_ON_START=1` exits immediately; writes received init key to `FAKE_KEY_OUT` file if set.
- [ ] **Step 2: Failing tests** (`TrukiBridgeSupervisor_test.main.ts`; spawn the fixture with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` set **only in the child's env**; fake clock via `now`/`setTimeoutFn`):
  - `does not start with no networks enabled` → `spawnFn` not called.
  - `starts, handshakes, and answers requests` → `request('echo', {a:1})` resolves `{a:1}`.
  - `passes the key only via init` → spawn argv and env contain no key; `FAKE_KEY_OUT` has a 64-char hex key; key file on disk is not that hex string.
  - `reuses the stored key across restarts` → two supervisors on one userData → same key received.
  - `refuses to start without encryption` → `isEncryptionAvailable` false → `request` rejects `BRIDGE_UNAVAILABLE`, nothing spawned, no key file written.
  - `forwards events` → `emit` → `onEvent` got `event.test`.
  - `fails in-flight requests on crash` → `hang` then `crash` → `hang` request rejects `BRIDGE_UNAVAILABLE`.
  - `backs off 1s, 2s, 4s and gives up after 5 crashes in 10 minutes` → with `FAKE_CRASH_ON_START`, scheduled delays are `[1000, 2000, 4000, 8000]` then `state === 'gave-up'` and requests reject `BRIDGE_STOPPED`.
  - `rejects incompatible protocol` → `FAKE_PROTOCOL=2` → `BRIDGE_INCOMPATIBLE`, no restart loop.
  - `shutdown sends shutdown and kills after 5s` → with `hang`-on-shutdown variant, child killed at 5000ms.
- [ ] **Step 3: Run, expect FAIL.** `env -u ELECTRON_RUN_AS_NODE pnpm run test-node -- --grep TrukiBridgeSupervisor` (on Windows `pnpm.cmd`).
- [ ] **Step 4: Implement.** Use `node:readline` on stdout with no line length limit; JSON-RPC ids are incrementing integers.
- [ ] **Step 5: Run, expect PASS.**
- [ ] **Step 6: Lint/types for the new files.** `pnpm run check:types` → still exactly the 2 baseline errors; `pnpm run oxlint` → still exactly 12. Fix any new ones (suffix errors: rename as lint says).
- [ ] **Step 7: Commit** `truki(bridge): main-process supervisor for truki-bridge`.

---

### Task 11: Wire into Truki, package and sign

**Files:**
- Create: `scripts/truki-build-bridge.mjs`
- Modify: `app/main.main.ts` (after line 2145, `AssetService.create(resourceService);`), `package.json`, `scripts/truki-sign-windows.mjs`

**Interfaces:**
- Consumes: `startTrukiBridgeSupervisor(getMainWindow)`.

- [ ] **Step 1: Upstream edit 1 — `app/main.main.ts`.** Add `import { startTrukiBridgeSupervisor } from './truki/TrukiBridgeSupervisor.main.ts';` as the last import in the import block, and `startTrukiBridgeSupervisor(getMainWindow);` on the line after `AssetService.create(resourceService);`. Nothing else in the file changes. `git diff --stat app/main.main.ts` → `2 insertions(+)`.
- [ ] **Step 2: `scripts/truki-build-bridge.mjs`.** Runs `truki-bridge/scripts/build.sh windows-amd64` (via `bash`; on Windows requires Git Bash + mingw on PATH — print a clear error otherwise), then copies `truki-bridge/dist/windows-amd64/truki-bridge.exe` to `build/truki-bridge/truki-bridge.exe`.
- [ ] **Step 3: Upstream edit 2 — `package.json`.** Add script `"build:truki-bridge": "node scripts/truki-build-bridge.mjs"` and a second `extraResources` entry `{ "from": "build/truki-bridge", "to": "", "filter": ["truki-bridge.exe"] }` after the existing one. Do not reorder anything. `git diff package.json` shows only added lines.
- [ ] **Step 4: Signing.** In `scripts/truki-sign-windows.mjs` (Truki-owned), include `resources/truki-bridge.exe` in the set of files signed. Check how the script is invoked by electron-builder's sign hook and make sure the helper is passed through it; if electron-builder already signs everything in `resources/`, note that and change nothing.
- [ ] **Step 5: Dev run.** `pnpm run build:truki-bridge`, start Truki in dev → main-process log shows no `truki-bridge` spawn. Quit, write `<userData>/truki-bridge/settings.json` = `{"enabledNetworks":["whatsapp"]}`, start again → log shows the `TrukiBridge` handshake with `protocolVersion 1` and three networks; quitting logs a clean `shutdown`. Delete the temp `settings.json`.
- [ ] **Step 6: Full verification** (paste each literal summary line):
  - `pnpm run check:types` → exactly the 2 baseline errors.
  - `pnpm run oxlint` → `✖ 12 problems (12 errors, 0 warnings)`.
  - `env -u ELECTRON_RUN_AS_NODE pnpm run test-node` → `N passing … / 12 pending`, 0 failing.
  - `cd truki-bridge && scripts/test.sh ./...` → all `ok`.
- [ ] **Step 7: Commit** `truki(bridge): start the bridge supervisor and package truki-bridge.exe`.

---

### Task 12: Manual verification with real accounts

No code. Run on the developer's machine with real accounts the developer is willing to risk (§10).

- [ ] **Step 1:** `truki-bridge/dist/linux-amd64/truki-bridge devcli --data /tmp/tb-manual` → `flows whatsapp` lists exactly `qr`, `phone`.
- [ ] **Step 2:** `login whatsapp qr`, scan with the phone → `complete`; `accounts` shows the number with `CONNECTED`; `chats` lists recent chats within a minute (backfill).
- [ ] **Step 3:** Receive a message from another phone → `event.message` printed. `send <chatId> test from truki-bridge` → arrives on the phone; event shows `status sent`.
- [ ] **Step 4:** `login meta messenger`, paste cookies from a logged-in messenger.com session → `complete`; receive and send one message.
- [ ] **Step 5:** Kill the devcli child with `kill -9` mid-session, restart devcli → no duplicate messages in `msgs <chatId>`; the WhatsApp login reconnects without a new QR.
- [ ] **Step 6:** Same as Steps 2–3 using the Windows build under the packaged Truki on Windows (`settings.json` toggle as in Task 11 Step 5), checking the main-process log.
- [ ] **Step 7:** Record results (pass/fail per step, any connector warnings) in `docs/truki/plans/2026-10-20-truki-bridge-manual-results.md` and commit.
