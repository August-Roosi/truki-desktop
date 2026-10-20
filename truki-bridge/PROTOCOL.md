# truki-bridge wire protocol

truki-bridge is spawned by Truki's Electron main process (the supervisor)
and speaks JSON-RPC 2.0 with it over the child's stdin/stdout. This
document describes the transport; RPC methods are added in later tasks as
they land and will be documented here.

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
| `NOT_FOUND`      | requested object does not exist                  |
| `INTERNAL`       | unexpected handler failure (also logged)         |

Handler errors that are not `rpc.Error` values are reported as `INTERNAL`
with the handler's error message and logged.
