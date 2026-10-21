# truki-bridge wire protocol

truki-bridge is spawned by Truki's Electron main process (the supervisor)
and speaks JSON-RPC 2.0 with it over the child's stdin/stdout. This
document describes the transport and the RPC methods, which are added as
they land.

## Framing

- One JSON-RPC 2.0 message per line, UTF-8, terminated by `\n`. No
  embedded newlines; messages must not be pretty-printed.
- The line cap is **16 MiB**. A line that exceeds it is discarded whole
  and answered with an `INVALID_INPUT` error (id `null`); the stream stays
  usable.
- Requests are JSON objects with `jsonrpc`, `id`, `method` and optional
  `params`. The `id` is echoed back verbatim. A message without `id` is a
  notification.
- **stderr is not part of the protocol.** The bridge logs zerolog JSON
  lines there; the supervisor may forward or drop them. The supervisor
  forwards them into Truki's main log, which users can upload, so the bridge
  logs at `info` level. A developer gets `debug` logs (which name contacts'
  network IDs) by setting `TRUKI_BRIDGE_LOG_LEVEL=debug` in the environment.

### Stdout guard

Before any other initialization the bridge duplicates its stdout and
serves RPC on the duplicate, then points its own stdout (fd 1 /
`STD_OUTPUT_HANDLE`) at stderr. Stray writes from libraries therefore land
in the log stream, never in the RPC stream.

## Handshake

The first request must be `init`. Until a successful `init`, every other
method answers `NOT_INITIALIZED`. A second `init` after a successful one
answers `INVALID_INPUT`; a failed `init` (for any reason) may be retried.

Request:

```json
{"jsonrpc":"2.0","id":1,"method":"init","params":{
  "protocolVersion":1,
  "dataDir":"/path/to/bridge/data",
  "dbKey":"<64 hex chars>"
}}
```

- `protocolVersion` (int): must be `1`, the current `ProtocolVersion`. Any
  other value is rejected with `INVALID_INPUT` without further processing;
  the supervisor maps that to `BRIDGE_INCOMPATIBLE`.
- `dataDir` (string): directory for the bridge database; created (with its
  `media/` subdirectory) when missing.
- `dbKey` (string): 64 hex chars, the raw SQLCipher key. Anything else is
  `INVALID_INPUT`.

A `dbKey` that does not decrypt an existing database answers `INTERNAL`
with a message containing `bad key`, and **the process then exits with
status 1**: no retry can succeed, so the supervisor treats it as a crash
(the key itself never appears in the error or the log). Any other failed
`init` may be retried: the bridge creates the data directory, opens
`<dataDir>/truki-bridge.db`, upgrades it, fails every event still
`pending` from a previous run (a pending send cannot survive a restart),
starts the bridges of the networks that have logins, and answers with the
networks it serves.

Result:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "bridgeVersion":"<version>",
  "networks":[{"id":"signal","name":"Signal"}]
}}
```

## Concurrency

After a successful `init` the bridge dispatches every request and
notification to its own goroutine. A slow handler therefore does not delay
other requests, and **responses may arrive in any order** — the supervisor
must match them to their requests by `id`. The `init` handshake itself is
synchronous: it is answered before any other method is dispatched. A
handler that panics is answered with `INTERNAL` (message `internal error`),
logged on stderr, and the bridge keeps serving.

## Notifications

- Bridge → Truki: notifications carry `method` and `params` and have no
  `id`; they are never answered. Event methods are added in later tasks.
- Truki → bridge: a message without `id` is accepted and dispatched to
  its method handler without a response. Errors while dispatching a
  notification are logged, not reported.

### Bridge events

- `event.message`: params are one **event** object (see Reading). Pushed
  for every stored or updated event, including the local user's outgoing
  events changing status.
- `event.chat`: params are one **chat** object. Pushed whenever a chat row
  changes (name, avatar, unread count, mute, last message).
- `event.accountState`: params are `{network, loginId, state}` with the
  same `state` values as `accounts.list`. Pushed for every bridge state
  change of a login.
- `event.notify`: params are `{network, chatId?, senderName?, messageId,
  message}` — a network notification (typically an incoming message for
  a chat the user has not opened). `chatId` and `senderName` are present
  when known.
- `event.typing`: params are `{chatId, users: [userId, ...]}`, the users
  currently typing in the chat (the full set, not a delta).
- `event.receipt`: params are `{chatId, userId, eventId}` — a read
  receipt.

The `event.login.step` notification of the login flows is described with
the login methods below.

## Methods

`chatId` is a chat's Matrix room ID (`!<uuid>:truki.local`); `eventId` is a
Matrix event ID. Params are strict: unknown fields, a missing `chatId` or a
wrong type answer `INVALID_INPUT`. An unknown chat, or an `eventId` or
`replyTo` that is not an event of that chat, answers `NOT_FOUND`.

The methods below hand the request to the network and return as soon as it
is queued. The outcome arrives later as `event.message` notifications for
the outgoing event.

### Outgoing events

Every outgoing event is `$truki-<uuid>` and is stored (and pushed) at once
with `status: "pending"`. When the network answers, the same event is pushed
again with `status: "sent"`, or `status: "failed"` and an `errorCode`.
`errorCode` is the network's error reason (for example
`m.foreign_network_error`), except that a rate limit is `RATE_LIMITED`.
**A `RATE_LIMITED` send is never retried by the bridge**; Truki surfaces it
and the user retries, to keep the risk of a ban low.

### `messages.send`

Params: `{chatId, text?, html?, replyTo?, attachments?}`, where
`attachments` is `[{path, name, mimeType?}]` (`path` is an absolute path to a
local file; `mimeType` is detected from the content when absent). `text` or
at least one attachment is required. `html` is the formatted version of
`text`.

Without attachments the result is one `m.text` event. With attachments each
file is its own `m.image` (image MIME types) or `m.file` event, uploaded to
the bridge's media store first; `text` becomes the caption of the first
file, and `replyTo` applies to the first event. A file that cannot be read
answers `INVALID_INPUT` before anything is sent.

**Attachment paths must originate in Truki's main process.** The bridge
reads whatever `path` it is given, so the supervisor's renderer IPC channel
(`truki-bridge:request`) refuses a `messages.send` whose `attachments` is not
empty, with `INVALID_INPUT` ("attachments over IPC are not supported yet"),
without forwarding it. Main-process callers of `TrukiBridgeSupervisor.request()`
may send attachments.

Result: `{eventId}`, the ID of the first event sent.

### `messages.react`

Params: `{chatId, eventId, key}`: `key` is the emoji. Result: `{eventId}`,
the ID of the `m.reaction` event, which is pending until the network
answers.

### `messages.redact`

Params: `{chatId, eventId}`. Deletes the message, or removes the reaction,
that `eventId` names. Result: `{}`. The redaction is itself an outgoing
`m.room.redaction` event with a status; when the network accepts it, the
target is flagged `redacted` and pushed again. A redacted event (from either
side) keeps only `m.relates_to` of its content (or `{}`): its body and media
references are gone from the stored event, the search index and every later
push. (A downloaded media file itself stays in the media store.)

### `chats.markRead`

Params: `{chatId, eventId}`. The chat's unread count becomes the number of
other people's messages after `eventId` (so 0 for the newest), an
`event.chat` is pushed, and a read receipt for `eventId` is sent to the
network. Result: `{}`.

### `chats.setMuted`

Params: `{chatId, until?}`, where `until` is an RFC 3339 time; absent or
`null` unmutes. Only the chat's `mutedUntil` changes (and an `event.chat` is
pushed); the mute is not sent to the network. Result: `{}`.

## Reading

The read-side methods return the store as it is now. Two objects recur:

- A **chat**: `{id, network, loginId, name, topic, avatar?, isDm,
  unreadCount, mutedUntil?, lastActivity?, lastEventId?}`, with the times
  as RFC 3339 and `avatar` the `mxc://` content URI of the chat's avatar.
- An **event**: `{id, chatId, sender, type, content, timestamp?,
  streamOrder, status?, errorCode?, redacted?, relatesTo?, relType?}`,
  where `content` is the Matrix event content as stored, `streamOrder`
  is the event's absolute position in the chat (newest = highest), and
  `status`/`errorCode` only exist for the local user's outgoing events.

### `networks.list`

No params. Result: `[{id, name, enabled}]`, every network the bridge
serves, where `enabled` means the network has at least one logged-in
account.

### `chats.list`

Params: `{cursor?, limit?}`, chats ordered by last activity, newest
first. `limit` defaults to 50 and is clamped to 200. Result:
`{chats: [chat, ...], nextCursor}`, where `nextCursor` is the opaque
cursor of the next page, or `""`/absent when there are no more chats. A
`cursor` that is not one of the bridge's answers `INVALID_INPUT`.

### `chats.get`

Params: `{chatId}`. Result: `{chat, members}`, `members` being
`{userId: m.room.member content}` of the chat. `NOT_FOUND` for an unknown
chat.

### `messages.list`

Params: `{chatId, before?, limit?}`. Result: `{events: [event, ...]}`,
the chat's events newest first. `before` is a `streamOrder` from a
previous page: only events below it are returned, which is how a client
pages back through history. `limit` defaults to 50 and is clamped to 200.
`NOT_FOUND` for an unknown chat.

### `media.path`

Params: `{mediaId}`, an `mxc://truki.local/<sha256 hex>` content URI as
stored in event content. Result: `{path}`, the absolute path of the media
file in `<dataDir>/media/`. Only such URIs resolve: anything that is not
a parseable `mxc://` URI answers `INVALID_INPUT`; a parseable URI that is
not local media (another server, a non-hash file ID) or whose file is
missing answers `NOT_FOUND`. A media ID can never name a path outside the
media directory.

### `search`

Params: `{query, limit?}`. Result: `[event, ...]`, matching events most
relevant first, redacted events excluded. `query` is FTS5 syntax (a plain
word works); a query that does not parse answers `INVALID_INPUT`.
`limit` defaults to 20 and is clamped to 100.

### `shutdown`

No params. Result: `{}`. The bridge stops its bridges, closes the
database and exits with status 0 right after the reply. It does not
answer anything else afterwards.

## Login and accounts

Logins mirror bridgev2's provisioning API, with the same step objects. A
step is bridgev2's `LoginStep` as-is: `type` (`user_input`, `cookies`,
`display_and_wait` or `complete`), `step_id`, `txn_id`, `instructions`, and
one of `user_input`, `cookies`, `display_and_wait`, `complete` holding that
type's parameters. Every account belongs to the local user.

`network` is a network ID from `init`. An unknown network answers
`NOT_FOUND`.

### `login.flows`

Params: `{network}`. Result: `[{id, name, description}]`, only the flows the
network's definition allows; other flows the connector has are hidden.

### `login.start`

Params: `{network, flowId}`. Result: `{processId, step, seq}`. A `flowId`
that is not in `login.flows` answers `INVALID_INPUT`.

A network has at most one login process. **A second `login.start` for the
same network cancels the first** (its `processId` then answers `NOT_FOUND`);
the user may have closed the first dialog without cancelling it. Processes
that are idle for 10 minutes (no start or submit) are cancelled the same way
and an `event.login.step` with error `LOGIN_EXPIRED` is pushed.

### `login.submit`

Params: `{processId, stepId, input?, cookies?}`. `stepId` must be the
current step's `step_id` (else `INVALID_INPUT`, and the process stays
open). `input` (`{field: value}`) answers a `user_input` step and `cookies`
(`{field: value}`) a `cookies` step; the other one must be absent. A
`display_and_wait` or `complete` step cannot be submitted. Result:
`{step, seq}`.

When the step is `complete`, the account exists and `step.complete` names
its `user_login_id`; the process is gone.

If the network rejects the submission the call answers `LOGIN_FAILED` and
the process is gone too (as in provisioning): start a new one. An unknown
or finished `processId` answers `NOT_FOUND`.

### `login.cancel`

Params: `{processId}`. Result: `{}`. `NOT_FOUND` for an unknown process.

### `event.login.step`

Bridge to Truki. Sent while a process sits on a `display_and_wait` step: the
bridge waits for the network, and pushes every following step (a refreshed
QR code, the next question, `complete`) as `{processId, step, seq}`. If the
wait fails (for example a QR code that nobody scanned), the push is
`{processId, error: {code, message}}` and the process is gone: the user
starts again with `login.start`. `code` is the network's error code
(`LOGIN_FAILED` when it has none). No event follows cancelling a process.

`seq` counts the steps of a process (1 for the first). A step can be
reported both as a result and as an event, and an event can arrive before the
result of the call that created the process or step. The client therefore
keeps the step with the highest `seq` and buffers events whose `processId`
it does not know yet.

### `accounts.list`

No params. Result: `[{loginId, network, remoteName, state}]` for every login
of every network, `state` being the latest bridge state (`CONNECTED`,
`TRANSIENT_DISCONNECT`, `BAD_CREDENTIALS`, ...; `UNKNOWN` before the first
one). Changes arrive as `event.accountState`.

### `accounts.logout`

Params: `{loginId, network?}`. Logs the account out of the network, removes
it, and reports `LOGGED_OUT` through `event.accountState`. Result: `{}`.
`NOT_FOUND` for an unknown login. `network` is only required when the same
`loginId` exists on several networks (else `INVALID_INPUT`).

Login secrets (passwords, cookies, tokens) are only ever held in the
`login.submit` call; the bridge does not log them.

## Errors

Every error response carries the JSON-RPC code and, in `data.code`, the
Truki string code:

```json
{"jsonrpc":"2.0","id":1,"error":{
  "code":-32602,
  "message":"unsupported protocolVersion 2, want 1",
  "data":{"code":"INVALID_INPUT"}
}}
```

JSON-RPC codes:

| code   | meaning                                    |
|--------|--------------------------------------------|
| -32700 | line is not valid JSON (id is `null`)      |
| -32600 | valid JSON, not a usable request           |
| -32601 | unknown method                            |
| -32602 | `INVALID_INPUT` from params or handlers    |
| -32000 | every other Truki code                     |

Truki codes (`data.code`):

| code             | meaning                                          |
|------------------|--------------------------------------------------|
| `NOT_INITIALIZED`| method called before a successful `init`         |
| `INVALID_INPUT`  | bad params, unknown method, oversize line        |
| `NOT_FOUND`      | requested chat, event, login or process does not exist |
| `LOGIN_FAILED`   | the network rejected a login step; the process is gone |
| `INTERNAL`       | unexpected handler failure (also logged)         |

Handler errors that are not `rpc.Error` values are reported as `INTERNAL`
with the handler's error message and logged.

An `INTERNAL` error is logged with its message. Any other handler error is
logged with only its method and code, never its message: a `LOGIN_FAILED`
message is the network's text and may quote what the user typed.

## Implementation notes

These record where bridgev2 (mautrix v0.32.0) assumes a Matrix homeserver,
and how truki-bridge handles each one. They are bridge internals, not wire
protocol.

- **One database, many bridges.** Every network runs its own
  `bridgev2.Bridge` with bridge ID = network ID, all on the one SQLCipher
  database. bridgev2's tables carry a `bridge_id` column and its upgrades
  use the `version` table; the store uses `truki_version`, so the two
  coexist. `database.New` overwrites `UpgradeTable` on the handle it gets,
  so each bridge gets its own `dbutil` child handle. Every bridge is
  `ExternallyManagedDB`: the host runs bridgev2's upgrades once, and a
  bridge's `Stop` does not close the shared database.
- **`PostStart` runs synchronously.** `Bridge.Start` runs it in a
  goroutine nothing waits for, which raced `Stop` and the database being
  closed. The host calls `StartConnectors`, `StartLogins` and `PostStart`
  itself, as mxmain does.
- **Management room.** Bridge-state notices are posted to a management room
  (a chat with the bridge bot), which would show up as a chat in Truki.
  `bridge_status_notices` is `none`; account state reaches Truki through
  `SendBridgeStatus` instead.
- **Personal filtering spaces** are off: Truki has its own spaces. Space
  rooms bridgev2 creates anyway get no chat row.
- **Double puppeting needs no token.** bridgev2 asks for the local user's
  double puppet with the stored (empty) access token; the Truki connector
  returns its `@me:truki.local` intent for any token, so no double-puppet
  login is needed. `@me:truki.local` has admin permissions and owns every
  login.
- **Event IDs of live remote messages are deterministic.** bridgev2 saves
  its message row only after the Matrix send returns. A homeserver dedups a
  replay by transaction ID; bridgev2 sends none for remote messages, so a
  restart between the two writes stored the message twice. The connector
  derives the event ID of a new message part (`MessageMeta` without MXID)
  from the portal key, message ID and part ID, so the replay is a no-op.
- **Chat login.** A portal without a receiver (not split per login) has no
  login in its bridge info. bridgev2 records the source login in the portal
  before creating the room, so `CreateRoom` takes the lowest-sorting login
  in the portal. With several logins in one shared portal, the chat names
  one of them.
- **Direct media is off.** It is only enabled when the Matrix connector
  calls `SetUseDirectMedia`, which the Truki connector never does, so
  networks reupload media through the connector. Network config keys that
  depend on it (e.g. WhatsApp's `direct_media_auto_request`) have no effect.
- **Outgoing message re-ID is off** (`outgoing_message_re_id: false`), so an
  outgoing message keeps the event ID it was stored under.
- **Network config** is the connector's own example config, unmarshalled
  into its config struct (lines with `$<<...>>` templates are dropped; the
  WhatsApp, Meta, Signal and Telegram examples have none), then validated
  when the connector supports it. There is no config file.
