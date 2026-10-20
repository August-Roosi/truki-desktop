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
  lines there; the supervisor may forward or drop them.

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
- `dataDir` (string): directory for the bridge database.
- `dbKey` (string): 64 hex chars, the raw SQLCipher key.

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

Result: `{eventId}`, the ID of the first event sent.

### `messages.react`

Params: `{chatId, eventId, key}`: `key` is the emoji. Result: `{eventId}`,
the ID of the `m.reaction` event, which is pending until the network
answers.

### `messages.redact`

Params: `{chatId, eventId}`. Deletes the message, or removes the reaction,
that `eventId` names. Result: `{}`. The redaction is itself an outgoing
`m.room.redaction` event with a status; when the network accepts it, the
target is flagged `redacted` and pushed again.

### `chats.markRead`

Params: `{chatId, eventId}`. The chat's unread count becomes the number of
other people's messages after `eventId` (so 0 for the newest), an
`event.chat` is pushed, and a read receipt for `eventId` is sent to the
network. Result: `{}`.

### `chats.setMuted`

Params: `{chatId, until?}`, where `until` is an RFC 3339 time; absent or
`null` unmutes. Only the chat's `mutedUntil` changes (and an `event.chat` is
pushed); the mute is not sent to the network. Result: `{}`.

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
| `NOT_FOUND`      | requested chat or event does not exist           |
| `INTERNAL`       | unexpected handler failure (also logged)         |

Handler errors that are not `rpc.Error` values are reported as `INTERNAL`
with the handler's error message and logged.

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
