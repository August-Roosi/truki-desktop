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

- ~~Add `pnpm run build:truki-bridge` to the release steps in `TRUKI.md`~~
  (done in the Inbox sub-project).
- `go.mod` carries `replace github.com/imroc/req/v3 => github.com/beeper/req/v3`
  copied from mautrix-meta; re-sync it on every mautrix-meta bump.
- ~~WhatsApp device name, " (WA)" suffix, status broadcast~~ (done in the
  Inbox sub-project). Still open: animated stickers need ffmpeg (not
  shipped).
- `split_portals` is off: a group shared by two of the user's own accounts on
  one network is one chat. Turning it on later is one-way in bridgev2 — decide
  before users have data.

## Done in the Inbox sub-project

These were listed as "before the Inbox UI wires the renderer" and are closed:

- ~~Edits of a redacted message keep their text~~; ~~redaction before its
  target~~; ~~media files of redacted messages~~ (redaction edits,
  tombstones and media).
- ~~Attachments over IPC~~: now sent via a main-process file dialog
  (`truki-bridge:pick-attachment`).
- ~~`truki-media` privileged scheme~~ and its CSP entries.
- ~~`event.accountState` drops the error/message~~: now carries `reason`;
  global states (empty `loginId`) are ignored by the renderer.
- ~~Supervisor `gave-up` is permanent~~: `truki-bridge:restart` is the user
  restart path. ~~No log when `safeStorage` is unavailable~~: warning added.
- ~~Key file write is not atomic~~: now atomic.
- ~~Renderer must order login steps by `seq` and buffer events for unknown
  `processId`s~~.

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
