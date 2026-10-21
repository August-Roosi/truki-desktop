# Truki Bridge — follow-ups after sub-project 1

Sub-project 1 (`truki-bridge` + supervisor + packaging) is implemented and
reviewed on `feature/truki-bridge`. This file lists what is still open: the
manual check that needs real accounts, and the review findings deliberately
deferred to later work.

## Manual verification (plan Task 12) — needs real accounts

Use accounts you are willing to risk (spec §10). Step 1 already passed:
`devcli` → `flows whatsapp` lists exactly `qr` (QR) and `phone` (Pairing code).

1. `truki-bridge/dist/linux-amd64/truki-bridge devcli --data /tmp/tb-manual`
2. `login whatsapp qr`, scan with the phone → `complete`; `accounts` shows the
   number `CONNECTED`; `chats` lists recent chats within a minute.
3. Receive a message from another phone → `event.message` printed.
   `send <chatId> test from truki-bridge` → arrives; event shows `status sent`.
4. `login meta messenger`, paste cookies from a logged-in messenger.com
   session → `complete`; receive and send one message.
5. Kill the devcli child (`kill -9`) mid-session, restart devcli → no duplicate
   messages in `msgs <chatId>`; WhatsApp reconnects without a new QR.
6. Repeat 2–3 with the Windows build inside packaged Truki on Windows
   (`<userData>/truki-bridge/settings.json` = `{"enabledNetworks":["whatsapp"]}`),
   checking the main-process log.
7. **Windows auto-update with the bridge running**: install release N, enable
   a network, update to N+1 via the updater → install succeeds and
   `resources\truki-bridge.exe` is replaced (no locked-file failure).
8. Check history volume and `media/` disk use on a real Messenger account
   (backward backfill is capped at 5 batches for Meta/Instagram).

Record results in `2026-10-20-truki-bridge-manual-results.md`.

## Before the first release that ships the bridge

- Add `pnpm run build:truki-bridge` to the release steps in `TRUKI.md`;
  `build:release` does not build it, so a release without it ships no bridge.
- `go.mod` carries `replace github.com/imroc/req/v3 => github.com/beeper/req/v3`
  copied from mautrix-meta; re-sync it on every mautrix-meta bump.
- WhatsApp example-config defaults visible to users: `os_name`
  "Mautrix-WhatsApp bridge" (shown in the phone's Linked devices),
  `displayname_template` appends " (WA)", status broadcast enabled, animated
  stickers need ffmpeg (not shipped). Decide and override.
- `split_portals` is off: a group shared by two of the user's own accounts on
  one network is one chat. Turning it on later is one-way in bridgev2 — decide
  before users have data.

## Before the Inbox UI (sub-project 2) wires the renderer

- **Edits of a redacted message keep their text** (`m.replace` rows stay in the
  store and FTS). Strip the target's edits in `markRedacted`.
- A redaction that arrives before its target leaves the target unredacted.
- Media files of redacted messages stay in `media/` (reference is removed).
- Attachments over IPC are refused (ruling R19); add a main-issued path
  mechanism (file dialog result or staged copy) for the UI.
- `truki-media` must be added to upstream's `registerSchemesAsPrivileged` list
  (one additive entry) if the renderer needs fetch/CORS; with `standard: true`
  the host is lowercased and the path percent-encoded — mirror it.
- `event.accountState` drops the BridgeState error/message; global states
  arrive with `loginId: ""` (renderer must ignore them).
- Supervisor `gave-up` is permanent for the process; spec §6.1 wants a user
  restart path. No log when `safeStorage` is unavailable.
- Key file write is not atomic (torn first write → permanent lockout); use
  tmp + fsync + rename.
- Renderer must order login steps by `seq` and buffer events for unknown
  `processId`s.

## Smaller deferred items (safe to merge as is)

Recorded during per-task reviews; none blocks merge per the final review.

- Store: nullable text columns scanned into string; index unusable for
  `COALESCE` ordering; replay overwrites `room_id`; test hygiene.
- RPC: line cap slightly loose; non-object JSON gets -32700; `Dup2` absent on
  linux/arm64; Windows `SetStdHandle` does not move the C runtime's fd 1.
- Connector: `MarkReadBy` ignored in BatchSend; state rows accumulate per
  restart (power levels in memory); typing never expires; `DeleteRoom` no-op;
  live reaction IDs random (crash-window duplicate); reaction removed and
  re-added via backfill stays redacted.
- Host/login: `Stop` doesn't wait for portal goroutines; host lock held during
  network start; login `follow`/idle-timer races; timers armed after stop.
- Process: `dataDir` not validated; stdin EOF doesn't stop host; stale
  shutdown id after a pre-init shutdown.
- Supervisor: no request timeout; interleaved `setEnabledNetworks`;
  `settings.json` written on every launch; will-quit has no own timeout.
