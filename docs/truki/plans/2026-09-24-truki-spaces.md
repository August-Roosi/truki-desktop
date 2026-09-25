# Truki Spaces Implementation Plan

> **For agentic workers:** Implement this plan task-by-task, in order. Steps use
> checkbox (`- [ ]`) syntax for tracking. Do not start a task before the
> previous one's tests pass and are committed.

**Goal:** Let a user organise conversations into Spaces — a permanent, renameable
"General" plus user-created spaces, each with its own icon, accent colour, and an
option to keep its members out of General.

**Architecture:** Spaces are a thin Truki layer on upstream's existing Chat
Folders, not a parallel system. Three fields (`emoji`, `color`,
`hideFromAllChats`) are added to the chat folder record; the selected space's
colour is applied by overriding Axo's accent CSS custom properties on `<body>`;
the selector UI moves into the left pane header as a new, self-contained
component.

**Tech Stack:** TypeScript, React, Redux, better-sqlite3, protobufjs, Axo design
system + Tailwind (`tw()`), mocha + chai.

**Spec:** `docs/truki/specs/2026-09-24-truki-spaces-design.md` — read it before
starting. This plan argues from it.

## Global Constraints

Copied verbatim from `AGENTS.md` and the spec. **Every task's requirements
implicitly include this section.**

- **Never add an entry to `SCHEMA_VERSIONS`** in `ts/sql/migrations/index.node.ts`.
  Truki schema changes go through `ensureTrukiSchema` only.
- **All Truki protobuf field numbers are `>= 20001`.** Protobuf reserves
  19000–19999.
- **Edits to upstream files must be additive.** An upstream function must behave
  exactly as before when the new inputs are absent.
- **Never delete or rewrite upstream logic**, never reformat or reorder upstream
  code, never fix unrelated lint.
- **Editing an upstream test to make it pass is forbidden.** A failing upstream
  test means the change was not additive — fix the change.
- **Code keeps upstream's `chatFolder` naming.** "Space" is user-facing wording
  only. New Truki-owned files may use `TrukiSpace` names.
- File suffixes are load-bearing: `.std.ts` (environment-agnostic), `.dom.tsx`
  (renderer), `.preload.ts` (preload), `.node.ts` (main/SQL).
- Every new file starts with:
  ```
  // Copyright 2026 Truki
  // SPDX-License-Identifier: AGPL-3.0-only
  ```
  and **must have a `truki` path segment or a `Truki`/`truki` filename prefix**.
  `.oxlintrc.json` keys its license-rule override off exactly that convention,
  so a Truki file named otherwise fails lint. Do not change a Truki header to
  say "Signal Messenger, LLC".
- **File suffixes are derived from imports, not chosen.** A file using no
  node-only API must be `.std.ts` even under `ts/sql/`. If lint reports
  `Invalid suffix`, rename the file to what it asks for; never add an ignore.
- New user-facing strings go in `_locales/en/messages.json` under an `icu:` key.
  Do not hand-edit other locale files.

**Verification commands** (run the first three at the end of every task):

```sh
pnpm run check:types
pnpm run oxlint
pnpm run test-node
```

**Known pre-existing `check:types` errors on this checkout.** These are not
yours, are unrelated to Spaces, and must be left alone:

```
ts/updater/got.main.ts(5,8): TS6133: 'config' is declared but its value is never read.
ts/windows/main/attachments.preload.ts(205,32): TS2307: Cannot find module 'fs-xattr'
```

`fs-xattr` is a macOS-only optional dependency that is not installed on Windows.
A task is "type-clean" when these two are the *only* errors remaining.

**Known pre-existing `oxlint` errors — 12**, also not yours, also to be left
alone. See `AGENTS.md` for the per-file breakdown.

A task is "lint-clean" when exactly these 12 remain. `oxlint` exits non-zero
regardless, so read the output rather than the exit code — and re-measure
rather than trusting this number, which was wrong once already.

**On Windows, PowerShell may block `pnpm.ps1`.** Use `pnpm.cmd` instead. An
inherited `ELECTRON_RUN_AS_NODE=1` also breaks `test-node`; clear it for the
test process only.

## Review Focus

Input classes the spec implies but that no task's happy path exercises. Each has
a test pinned to the task that owns the code.

1. **`color = 0` arriving from the wire** must read back as "no colour", not as
   opaque black. proto3 `fixed32` has no presence, so `0` is the unset
   representation. — pinned in Task 3.
2. **A space with `hideFromAllChats` that is then deleted** must stop hiding its
   members. The hidden set must skip folders with `deletedAtTimestampMs > 0`. —
   pinned in Task 4.
3. **A multi-codepoint emoji or first grapheme** (flag, ZWJ family, skin tone)
   must not be split into a broken half by the icon fallback. Use
   `ts/util/grapheme.std.ts`, never `name[0]`. — pinned in Task 6.
4. **General with no emoji and no rename** has `name === ''`, so the grapheme
   fallback must come from the resolved i18n display label. A blank pill is a
   bug. — pinned in Task 6.
5. **A conversation hidden from General while it is the open chat** must not
   vanish from under the user mid-read; upstream's stable-selection escape
   hatch must still win. — pinned in Task 4.

---

## Task 1: Schema foundation — ensure-step, types, palette

**Files:**
- Create: `ts/sql/truki/ensureTrukiSchema.node.ts`
- Create: `ts/types/TrukiSpaceColor.std.ts`
- Create: `ts/test-node/sql/ensureTrukiSchema_test.node.ts`
- Modify: `ts/sql/migrations/index.node.ts` (import + one call at the end of `updateSchema`)
- Modify: `ts/types/ChatFolder.std.ts` (type fields, zod, defaults)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ensureTrukiSchema(db: WritableDB, logger: LoggerType): void`
  - `TrukiSpaceColor.PALETTE: ReadonlyArray<{ name: string; value: number }>`
  - `TrukiSpaceColor.toCssHex(color: number): string` — `0xAARRGGBB` → `#rrggbb`
  - `TrukiSpaceColor.fromWire(color: number): number | null` — `0` → `null`
  - `ChatFolder` gains `emoji: string | null`, `color: number | null`,
    `hideFromAllChats: boolean`

- [x] **Step 1: Write the failing test for the ensure step**

Create `ts/test-node/sql/ensureTrukiSchema_test.node.ts`:

```ts
// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import SQL from '@signalapp/sqlcipher';

import { ensureTrukiSchema } from '../../sql/truki/ensureTrukiSchema.node.ts';
import type { WritableDB } from '../../sql/Interface.std.ts';

function columnNames(db: WritableDB, table: string): Array<string> {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
    .map(row => row.name);
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => noopLogger,
} as never;

describe('ensureTrukiSchema', () => {
  let db: WritableDB;

  beforeEach(() => {
    db = new SQL(':memory:') as unknown as WritableDB;
    db.exec(`
      CREATE TABLE chatFolders (
        id TEXT NOT NULL PRIMARY KEY,
        folderType INTEGER NOT NULL,
        name TEXT NOT NULL
      ) STRICT;
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('adds the three Truki columns', () => {
    ensureTrukiSchema(db, noopLogger);
    const names = columnNames(db, 'chatFolders');
    assert.include(names, 'emoji');
    assert.include(names, 'color');
    assert.include(names, 'hideFromAllChats');
  });

  it('is idempotent', () => {
    ensureTrukiSchema(db, noopLogger);
    assert.doesNotThrow(() => ensureTrukiSchema(db, noopLogger));
    const names = columnNames(db, 'chatFolders');
    assert.strictEqual(names.filter(n => n === 'emoji').length, 1);
  });

  it('adds only the missing column when one already exists', () => {
    db.exec('ALTER TABLE chatFolders ADD COLUMN emoji TEXT;');
    ensureTrukiSchema(db, noopLogger);
    const names = columnNames(db, 'chatFolders');
    assert.include(names, 'color');
    assert.strictEqual(names.filter(n => n === 'emoji').length, 1);
  });

  it('does nothing when the chatFolders table is absent', () => {
    db.exec('DROP TABLE chatFolders;');
    assert.doesNotThrow(() => ensureTrukiSchema(db, noopLogger));
  });

  it('defaults hideFromAllChats to 0 for existing rows', () => {
    db.prepare(
      "INSERT INTO chatFolders (id, folderType, name) VALUES ('a', 1, '')"
    ).run();
    ensureTrukiSchema(db, noopLogger);
    const row = db
      .prepare('SELECT hideFromAllChats FROM chatFolders WHERE id = ?')
      .get<{ hideFromAllChats: number }>('a');
    assert.strictEqual(row?.hideFromAllChats, 0);
  });
});
```

- [x] **Step 2: Run it and confirm it fails**

```sh
pnpm run test-node -- --grep "ensureTrukiSchema"
```

Expected: FAIL — cannot resolve `../../sql/truki/ensureTrukiSchema.node.ts`.

If `@signalapp/sqlcipher` is not the right import for an in-memory test DB,
find how an existing SQL test opens one (`grep -rn "new SQL(\|:memory:" ts/test-node ts/test-electron`)
and match that, but keep the assertions identical.

- [x] **Step 3: Write the ensure step**

Create `ts/sql/truki/ensureTrukiSchema.node.ts`:

```ts
// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

//
// Truki schema changes deliberately live OUTSIDE upstream's numbered migration
// system. See AGENTS.md: the migration runner skips any version <= user_version,
// so a Truki entry in SCHEMA_VERSIONS would make future upstream migrations
// silently skip on Truki installs. This runs after upstream's loop, adds only
// what is missing, and never touches user_version.
//

import type { WritableDB } from '../Interface.std.ts';
import type { LoggerType } from '../../types/Logging.std.ts';

type ColumnAddition = Readonly<{
  table: string;
  column: string;
  definition: string;
}>;

const TRUKI_COLUMNS: ReadonlyArray<ColumnAddition> = [
  { table: 'chatFolders', column: 'emoji', definition: 'TEXT' },
  { table: 'chatFolders', column: 'color', definition: 'INTEGER' },
  {
    table: 'chatFolders',
    column: 'hideFromAllChats',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
];

function tableExists(db: WritableDB, table: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $table"
    )
    .get<{ 1: number }>({ table });
  return row != null;
}

function columnExists(db: WritableDB, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
    .some(row => row.name === column);
}

export function ensureTrukiSchema(db: WritableDB, logger: LoggerType): void {
  for (const { table, column, definition } of TRUKI_COLUMNS) {
    if (!tableExists(db, table)) {
      continue;
    }
    if (columnExists(db, table, column)) {
      continue;
    }
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    logger.info(`ensureTrukiSchema: added ${table}.${column}`);
  }
}
```

Note: the table and column names are compile-time constants from
`TRUKI_COLUMNS`, never user input, so interpolating them into the SQL string is
safe. `PRAGMA` and `ALTER TABLE` cannot take bound parameters for identifiers.

- [x] **Step 4: Run the test and confirm it passes**

```sh
pnpm run test-node -- --grep "ensureTrukiSchema"
```

Expected: 5 passing.

- [x] **Step 5: Call it from the end of `updateSchema`**

In `ts/sql/migrations/index.node.ts`, add the import alongside the existing
imports:

```ts
import { ensureTrukiSchema } from '../truki/ensureTrukiSchema.node.ts';
```

Then find the end of `updateSchema`, after the `while (i < SCHEMA_VERSIONS.length)`
loop and after `DataWriter.ensureMessageInsertTriggersAreEnabled(db)` /
`enableFTS5SecureDelete(db, logger)`. Add one line there:

```ts
  // Truki: additive schema, outside upstream's version counter. See AGENTS.md.
  ensureTrukiSchema(db, logger);
```

**Do not add anything to `SCHEMA_VERSIONS`.** This is the whole point of the
design — re-read the comment block in `ensureTrukiSchema.node.ts` if tempted.

- [x] **Step 6: Add the colour palette**

Create `ts/types/TrukiSpaceColor.std.ts`:

```ts
// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

export type TrukiSpaceColorOption = Readonly<{
  /** i18n-free stable key, used as the swatch's test id and aria label key */
  key: string;
  /** 0xAARRGGBB */
  value: number;
}>;

/**
 * Fixed palette. Values are chosen to hold contrast as a button fill in both
 * light and dark themes. Arbitrary custom colours are out of scope.
 */
export const PALETTE: ReadonlyArray<TrukiSpaceColorOption> = [
  { key: 'blue', value: 0xff2c6bed },
  { key: 'indigo', value: 0xff5151f6 },
  { key: 'purple', value: 0xff8d4cc3 },
  { key: 'magenta', value: 0xffc34a9c },
  { key: 'crimson', value: 0xffcc2d4e },
  { key: 'orange', value: 0xffd96b1e },
  { key: 'amber', value: 0xffb8890a },
  { key: 'green', value: 0xff3a7d44 },
  { key: 'teal', value: 0xff1a7f78 },
  { key: 'slate', value: 0xff5c6b7a },
];

/**
 * proto3 `fixed32` has no presence, so 0 on the wire means "unset".
 * A real colour always has a non-zero alpha byte.
 */
export function fromWire(color: number): number | null {
  return color === 0 ? null : color;
}

/** Inverse of fromWire. */
export function toWire(color: number | null): number {
  return color ?? 0;
}

/** 0xAARRGGBB -> '#rrggbb'. Alpha is dropped; the accent is always opaque. */
export function toCssHex(color: number): string {
  const rgb = color & 0x00ffffff;
  return `#${rgb.toString(16).padStart(6, '0')}`;
}
```

- [x] **Step 7: Add the fields to the ChatFolder type**

In `ts/types/ChatFolder.std.ts`:

Add to `ChatFolderPreset`'s type (inside the `Readonly<{ ... }>`), after
`excludedConversationIds`:

```ts
    hideFromAllChats: boolean;
```

Add to `ChatFolderParams`'s extension (alongside `name`):

```ts
      emoji: string | null;
      color: number | null;
```

Add to `ChatFolderPresetSchema`:

```ts
  hideFromAllChats: z.boolean(),
```

Add to `ChatFolderParamsSchema.extend({ ... })`:

```ts
  emoji: z.string().nullable(),
  color: z.number().int().nullable(),
```

Add to `CHAT_FOLDER_DEFAULTS`:

```ts
  emoji: null,
  color: null,
  hideFromAllChats: false,
```

Add to `ALL_CHATS_FOLDER_REQUIRED_PARAMS`:

```ts
  emoji: null,
  color: null,
  hideFromAllChats: false,
```

**Important:** `ALL_CHATS_FOLDER_REQUIRED_PARAMS` is spread as *defaults* at
creation time. General's `emoji` and `color` become user-editable in Task 7;
only the filter fields stay force-locked. `hideFromAllChats` is meaningless on
General and must always stay `false` there.

Extend `matchesChatFolderPreset` with the new preset field:

```ts
    params.hideFromAllChats === preset.hideFromAllChats &&
```

Extend `isSameChatFolderParams` so renames/recolours are detected:

```ts
export function isSameChatFolderParams(
  a: ChatFolderParams,
  b: ChatFolderParams
): boolean {
  return (
    a.name === b.name &&
    a.emoji === b.emoji &&
    a.color === b.color &&
    matchesChatFolderPreset(a, b)
  );
}
```

Also extend `CHAT_FOLDER_PRESETS` entries if `tsc` reports them as missing
`hideFromAllChats` — they spread `CHAT_FOLDER_DEFAULTS`, so they should be fine.

- [x] **Step 8: Typecheck, lint, test**

```sh
pnpm run check:types
pnpm run oxlint
pnpm run test-node
```

`check:types` will now report errors in four files, because each constructs a
`ChatFolder` or `ChatFolderParams` literal without the new fields:

```
ts/sql/server/chatFolders.std.ts                                (4x)  -> Task 2
ts/services/backups/import.preload.ts                                 -> Task 2
ts/components/preferences/chatFolders/PreferencesChatFoldersPage.dom.tsx -> Task 2
ts/services/storageRecordOps.preload.ts                               -> Task 3
```

**That is expected.** Do not fix any of them here. Any error *outside* that list
and outside the two pre-existing ones in Global Constraints is a real problem.

- [x] **Step 9: Commit**

```sh
git add ts/sql/truki ts/types/TrukiSpaceColor.std.ts ts/types/ChatFolder.std.ts \
        ts/sql/migrations/index.node.ts ts/test-node/sql/ensureTrukiSchema_test.node.ts
git commit -m "truki(spaces): add emoji/color/hideFromAllChats schema foundation"
```

---

## Task 2: SQL persistence

**Files:**
- Modify: `ts/sql/server/chatFolders.std.ts`
- Modify: `ts/services/backups/import.preload.ts:4051`
- Modify: `ts/components/preferences/chatFolders/PreferencesChatFoldersPage.dom.tsx:377`
- Test: `ts/test-node/sql/trukiChatFolderColumns_test.node.ts` (create)

**Interfaces:**
- Consumes: `ChatFolder` with `emoji`/`color`/`hideFromAllChats` from Task 1.
- Produces: the three fields round-trip through `createChatFolder`,
  `getChatFolder`, `updateChatFolder`, and `upsertAllChatsChatFolderFromSync`.

**Background you need:** every read in this file uses `SELECT *`, and
`rowToChatFolder` spreads the row. So reads pick up the new columns with **no
changes at all**. Only the explicit column lists in `_insertChatFolder`,
`updateChatFolder` and `upsertAllChatsChatFolderFromSync` need editing.

`ChatFolderRow` maps booleans to `0 | 1`. `hideFromAllChats` needs the same
treatment; `emoji` and `color` are nullable scalars and pass through unchanged.

- [x] **Step 1: Write the failing test**

Create `ts/test-node/sql/trukiChatFolderColumns_test.node.ts`. Open a real
database the same way the existing SQL tests do — find one first:

```sh
grep -rln "createChatFolder\|_insertChatFolder" ts/test-node ts/test-electron
grep -rn "setupTests\|new SQL(" ts/test-node | head
```

Model the test on whatever harness that reveals, asserting:

```ts
it('round-trips emoji, color and hideFromAllChats', () => {
  const folder = {
    ...CHAT_FOLDER_DEFAULTS,
    id: generateUuid() as ChatFolderId,
    name: 'Work',
    emoji: '💼',
    color: 0xff3a7d44,
    hideFromAllChats: true,
    position: 1,
    deletedAtTimestampMs: 0,
    storageID: null,
    storageVersion: null,
    storageUnknownFields: null,
    storageNeedsSync: true,
  };
  createChatFolder(db, folder);
  const read = getChatFolder(db, folder.id);
  assert.strictEqual(read?.emoji, '💼');
  assert.strictEqual(read?.color, 0xff3a7d44);
  assert.strictEqual(read?.hideFromAllChats, true);
});

it('round-trips null emoji and color', () => {
  // same shape, emoji: null, color: null, hideFromAllChats: false
  // assert they read back as null / null / false, not undefined / 0 / 0
});

it('persists updates to the three fields', () => {
  // createChatFolder, then updateChatFolder with changed values, then read back
});

it('syncs name, emoji and color onto the All-chats folder', () => {
  // createAllChatsChatFolder(db), then upsertAllChatsChatFolderFromSync
  // with name: 'General', emoji: '🏠', color: 0xff2c6bed
  // assert all three landed — upstream's UPDATE does NOT include name
});
```

- [ ] **Step 2: Run it and confirm it fails**

```sh
pnpm run test-node -- --grep "trukiChatFolderColumns"
```

Expected: FAIL. The precise failure depends on which assertion runs first, but
the shape is: `emoji` and `color` read back as `null` (SQLite returns `null` for
a nullable column the INSERT never named, not `undefined`), `hideFromAllChats`
reads back as `false` via the row converter (the column's SQL default is `0`),
and the All-chats `name` is still `''` after the sync upsert.

- [x] **Step 3: Extend `ChatFolderRow`**

In the `Omit<...>` union of `ChatFolderRow`, add `'hideFromAllChats'`, and in
the intersection object add:

```ts
    hideFromAllChats: 0 | 1;
```

`emoji` and `color` need no entry — they are already the right scalar types on
`ChatFolder`.

- [x] **Step 4: Extend the row converters**

In `chatFolderToRow`, alongside the other boolean conversions:

```ts
    hideFromAllChats: chatFolder.hideFromAllChats ? 1 : 0,
```

In `rowToChatFolder`:

```ts
    hideFromAllChats: chatFolderRow.hideFromAllChats === 1,
```

- [x] **Step 5: Extend `_insertChatFolder`**

Add the three columns to the `INSERT INTO chatFolders (...)` list, after
`excludedConversationIds`:

```
      emoji,
      color,
      hideFromAllChats,
```

and the three matching values to the `VALUES (...)` list, in the same position:

```
      ${chatFolderRow.emoji},
      ${chatFolderRow.color},
      ${chatFolderRow.hideFromAllChats},
```

Column order and value order must match exactly.

- [x] **Step 6: Extend `updateChatFolder`**

Add to the `SET` clause, after `excludedConversationIds = ...`:

```
      emoji = ${chatFolderRow.emoji},
      color = ${chatFolderRow.color},
      hideFromAllChats = ${chatFolderRow.hideFromAllChats},
```

- [x] **Step 7: Let General's name, emoji and colour arrive from sync**

Upstream's `upsertAllChatsChatFolderFromSync` deliberately updates only `id`,
`position` and the storage bookkeeping fields — it never writes `name`, because
upstream's All-chats folder has no user-visible name. Truki makes it renameable,
so the UPDATE must carry it. Add to that `SET` clause:

```
          name = ${chatFolderRow.name},
          emoji = ${chatFolderRow.emoji},
          color = ${chatFolderRow.color},
```

Leave every filter field out. General's filter behaviour must stay locked.

- [x] **Step 8: Satisfy the two other `ChatFolder` constructors**

Task 1 made three fields required, so every place that builds a `ChatFolder` or
`ChatFolderParams` literal must supply them. Two sit outside the SQL layer:

`ts/services/backups/import.preload.ts:4051` — add the defaults to the object
literal:

```ts
      hideFromAllChats: false,
      emoji: null,
      color: null,
```

Carrying these fields through the backup proto is **out of scope** (spec §9):
storage service sync repopulates them after a restore. This is a type fix only —
do not add fields to `protos/backups.proto`.

`ts/components/preferences/chatFolders/PreferencesChatFoldersPage.dom.tsx:377` —
add `emoji: null` and `color: null` to the params literal. Task 7 builds the
real pickers on top; this is the minimal fix that keeps the tree type-clean in
between.

- [x] **Step 9: Run the tests**

```sh
pnpm run test-node -- --grep "trukiChatFolderColumns"
pnpm run check:types
```

Expected: 4 passing. `check:types` now reports only
`ts/services/storageRecordOps.preload.ts` (fixed in Task 3) plus the two
pre-existing errors listed in Global Constraints.

- [x] **Step 10: Commit**

```sh
git add ts/sql/server/chatFolders.std.ts ts/services/backups/import.preload.ts \
        ts/components/preferences/chatFolders/PreferencesChatFoldersPage.dom.tsx \
        ts/test-node/sql/trukiChatFolderColumns_test.node.ts
git commit -m "truki(spaces): persist emoji/color/hideFromAllChats in sqlite"
```

---

## Task 3: Storage service sync

**Files:**
- Modify: `protos/SignalStorage.proto` (message `ChatFolderRecord`, ~line 381)
- Modify: `ts/services/storageRecordOps.preload.ts` (`toChatFolderRecord` ~line 984, and the merge path ~line 2880)
- Test: `ts/test-node/services/trukiChatFolderRecord_test.preload.ts` (create)

**Interfaces:**
- Consumes: `ChatFolder` fields from Task 1, `fromWire`/`toWire` from
  `ts/types/TrukiSpaceColor.std.ts`.
- Produces: the three fields survive a `toChatFolderRecord` →
  `mergeChatFolderRecord` round-trip, and `$unknown` is still preserved.

- [x] **Step 1: Add the proto fields**

In `protos/SignalStorage.proto`, inside `message ChatFolderRecord`, after the
existing field 11 (`deletedAtTimestampMs`):

```proto
  // ---- Truki extensions ----
  // Field numbers >= 20001 are reserved for Truki so upstream additions
  // (which continue from 12) can never collide. Protobuf reserves 19000-19999.
  optional string emoji  = 20001;
  fixed32 color          = 20002;  // 0xAARRGGBB, 0 means unset
  bool hideFromAllChats  = 20003;
```

- [x] **Step 2: Regenerate the protobuf bindings**

```sh
pnpm run generate
```

If that script is heavier than needed, find the proto-specific one:

```sh
node -e "const s=require('./package.json').scripts;for(const k in s)if(/proto/i.test(k)||/proto/i.test(s[k]))console.log(k,'|',s[k])"
```

Confirm `Proto.ChatFolderRecord` now offers `emoji`, `color` and
`hideFromAllChats` before continuing.

- [x] **Step 3: Write the failing round-trip test**

Create `ts/test-node/services/trukiChatFolderRecord_test.preload.ts`. It must
cover Review Focus item 1:

It imports preload-only storage code, so the test itself must use the
`.preload.ts` suffix. A `.node.ts` suffix violates the import-graph linter.

```ts
it('round-trips emoji, color and hideFromAllChats', () => {
  // build a ChatFolder with emoji '💼', color 0xff3a7d44, hideFromAllChats true
  // toChatFolderRecord -> encode -> decode -> assert all three survive
});

it('maps a wire color of 0 back to null, not black', () => {
  // decode a record with color unset (0)
  // assert the resulting ChatFolder has color === null
  // REGRESSION GUARD: 0 must never become 0xff000000 or 0
});

it('treats an absent emoji as null', () => {
  // assert emoji === null, not '' and not undefined
});

it('still preserves $unknown alongside the Truki fields', () => {
  // a record carrying unknown bytes must keep them after a round-trip
});
```

Find how the merge side is reached — `mergeChatFolderRecord` is not exported
in the same shape as `toChatFolderRecord`:

```sh
grep -n "mergeChatFolderRecord\|function fromChatFolderRecord" ts/services/storageRecordOps.preload.ts
```

If the decode path is not directly callable from a node test, test
`toChatFolderRecord` plus a direct `Proto.ChatFolderRecord.decode(encode(...))`
and assert on the decoded record's fields; then assert the mapping helper you
write in Step 6 converts them correctly.

- [x] **Step 4: Run it and confirm it fails**

```sh
pnpm run test-node -- --grep "trukiChatFolderRecord"
```

Expected: FAIL — the fields are not written.

- [x] **Step 5: Write the encode side**

In `toChatFolderRecord`, add to the returned object, before `$unknown`:

```ts
    emoji: chatFolder.emoji,
    color: TrukiSpaceColor.toWire(chatFolder.color),
    hideFromAllChats: chatFolder.hideFromAllChats,
```

with the import:

```ts
import * as TrukiSpaceColor from '../types/TrukiSpaceColor.std.ts';
```

Keep `$unknown: fromStorageUnknownFields(chatFolder.storageUnknownFields)` as
the last property, exactly as upstream has it.

- [x] **Step 6: Write the decode side**

Around line 2880, in the function that builds `remoteChatFolder` from
`remoteChatFolderRecord`, add the three fields to the constructed object:

```ts
    emoji: remoteChatFolderRecord.emoji ?? null,
    color: TrukiSpaceColor.fromWire(remoteChatFolderRecord.color ?? 0),
    hideFromAllChats: remoteChatFolderRecord.hideFromAllChats ?? false,
```

`fromWire` is what makes Review Focus item 1 pass — do not inline `?? null`
here, `0` is a real value that must become `null`.

- [x] **Step 7: Run the tests**

```sh
pnpm run test-node -- --grep "trukiChatFolderRecord"
pnpm run check:types
pnpm run oxlint
```

Expected: 4 passing, and `check:types` now clean apart from the two pre-existing
errors listed in Global Constraints — all Task 1 fallout is resolved.

- [x] **Step 8: Commit**

```sh
git add protos/SignalStorage.proto ts/services/storageRecordOps.preload.ts \
        ts/test-node/services/trukiChatFolderRecord_test.preload.ts
git commit -m "truki(spaces): sync emoji/color/hideFromAllChats via storage service"
```

---

## Task 4: Hide members from General

**Files:**
- Modify: `ts/types/ChatFolder.std.ts` (options type + the ALL branch)
- Modify: `ts/state/selectors/chatFolders.std.ts` (new selector)
- Modify: `ts/state/selectors/conversations.dom.ts:423`
- Modify: `ts/util/countUnreadStats.std.ts:224`
- Modify: `ts/util/countMutedStats.std.ts:45`
- Modify: `ts/state/ducks/conversations.preload.ts:1479`
- Modify: `ts/state/ducks/chatFolders.preload.ts:292`
- Test: `ts/test-node/types/trukiHideFromAllChats_test.std.ts` (create)

**Interfaces:**
- Consumes: `hideFromAllChats` from Task 1.
- Produces:
  - `ChatFolderConversationFilterOptions` gains
    `hiddenFromAllChatsConversationIds?: ReadonlySet<string>`
  - `getHiddenFromAllChatsConversationIds(state): ReadonlySet<string>`
  - `countAllChatFoldersUnreadStats` and `countAllChatFoldersMutedStats` each
    gain a trailing optional `hiddenFromAllChatsConversationIds` parameter

- [x] **Step 1: Write the failing predicate test**

Create `ts/test-node/types/trukiHideFromAllChats_test.std.ts`:

```ts
// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  ChatFolderType,
  CHAT_FOLDER_DEFAULTS,
  isConversationInChatFolder,
  type ChatFolder,
  type ChatFolderId,
} from '../../types/ChatFolder.std.ts';

function folder(overrides: Partial<ChatFolder>): ChatFolder {
  return {
    ...CHAT_FOLDER_DEFAULTS,
    id: 'folder-1' as ChatFolderId,
    position: 0,
    deletedAtTimestampMs: 0,
    storageID: null,
    storageVersion: null,
    storageUnknownFields: null,
    storageNeedsSync: false,
    ...overrides,
  };
}

const conversation = {
  id: 'convo-1',
  type: 'direct' as const,
  unreadCount: 0,
  markedUnread: false,
  muteExpiresAt: undefined,
};

describe('hideFromAllChats filtering', () => {
  const allFolder = folder({ folderType: ChatFolderType.ALL, name: '' });

  it('keeps upstream behaviour when no hidden set is passed', () => {
    assert.isTrue(isConversationInChatFolder(allFolder, conversation));
  });

  it('keeps upstream behaviour for an empty hidden set', () => {
    assert.isTrue(
      isConversationInChatFolder(allFolder, conversation, {
        hiddenFromAllChatsConversationIds: new Set(),
      })
    );
  });

  it('excludes a hidden conversation from the All-chats folder', () => {
    assert.isFalse(
      isConversationInChatFolder(allFolder, conversation, {
        hiddenFromAllChatsConversationIds: new Set(['convo-1']),
      })
    );
  });

  it('does not affect custom folders', () => {
    const custom = folder({
      folderType: ChatFolderType.CUSTOM,
      name: 'Work',
      includeAllIndividualChats: true,
    });
    assert.isTrue(
      isConversationInChatFolder(custom, conversation, {
        hiddenFromAllChatsConversationIds: new Set(['convo-1']),
      })
    );
  });
});
```

- [x] **Step 2: Run it and confirm the third case fails**

```sh
pnpm run test-node -- --grep "hideFromAllChats filtering"
```

Expected: 3 passing, 1 failing — "excludes a hidden conversation".

- [x] **Step 3: Change the predicate**

In `ts/types/ChatFolder.std.ts`, extend the options type:

```ts
export type ChatFolderConversationFilterOptions = Readonly<{
  ignoreShowOnlyUnread?: boolean;
  ignoreShowMutedChats?: boolean;
  /**
   * Truki: conversations claimed by a space with hideFromAllChats set. They
   * are omitted from the All-chats folder only. Absent means nothing is hidden,
   * which is upstream's behaviour.
   */
  hiddenFromAllChatsConversationIds?: ReadonlySet<string>;
}>;
```

and change the ALL branch of `isConversationInChatFolder` — this is the single
line that makes the whole feature work:

```ts
  if (chatFolder.folderType === ChatFolderType.ALL) {
    return !options.hiddenFromAllChatsConversationIds?.has(conversation.id);
  }
```

- [x] **Step 4: Run the test and confirm 4 passing**

```sh
pnpm run test-node -- --grep "hideFromAllChats filtering"
```

- [x] **Step 5: Write the failing selector test**

Append to the same test file. This covers **Review Focus item 2**:

```ts
describe('getHiddenFromAllChatsConversationIds', () => {
  it('is empty when no space hides', () => {
    // two CUSTOM folders with hideFromAllChats false -> empty set
  });

  it('unions members across several hiding spaces', () => {
    // folder A hides, includes ['a', 'b']; folder B hides, includes ['b', 'c']
    // -> set is exactly {a, b, c}
  });

  it('ignores a deleted space', () => {
    // folder with hideFromAllChats true AND deletedAtTimestampMs > 0
    // -> its members are NOT hidden
    // REGRESSION GUARD: deleting a hiding space must un-hide its members
  });

  it('ignores the All-chats folder itself', () => {
    // an ALL folder can never contribute to the hidden set
  });
});
```

Build the state fixture the way the neighbouring selector tests in
`ts/test-node`/`ts/test-electron` do — find one:

```sh
grep -rln "getCurrentChatFolders\|CurrentChatFolders" ts/test-node ts/test-electron
```

- [x] **Step 6: Write the selector**

In `ts/state/selectors/chatFolders.std.ts`, add:

```ts
/**
 * Truki: the union of conversations claimed by any live CUSTOM space with
 * hideFromAllChats set. Derived, never stored, so it cannot drift out of sync
 * with membership.
 */
export const getHiddenFromAllChatsConversationIds = createSelector(
  getCurrentChatFolders,
  (currentChatFolders): ReadonlySet<string> => {
    const hidden = new Set<string>();
    for (const chatFolder of CurrentChatFolders.toSortedArray(
      currentChatFolders
    )) {
      if (
        chatFolder.folderType !== ChatFolderType.CUSTOM ||
        !chatFolder.hideFromAllChats ||
        chatFolder.deletedAtTimestampMs > 0
      ) {
        continue;
      }
      for (const id of chatFolder.includedConversationIds) {
        hidden.add(id);
      }
    }
    return hidden;
  }
);
```

Match the file's existing import and `createSelector` style exactly.

Note this uses `includedConversationIds` only. A space built from
`includeAllIndividualChats` / `includeAllGroupChats` would need every
conversation enumerated, which the selector does not have access to. That is a
known limitation: **hiding applies to explicitly-added members.** Add that
sentence as a comment above the selector.

- [x] **Step 7: Run the selector tests**

```sh
pnpm run test-node -- --grep "getHiddenFromAllChatsConversationIds"
```

Expected: 4 passing.

- [x] **Step 8: Thread the set into the five call sites**

Each is additive — a new trailing optional parameter, defaulted so existing
callers are unchanged.

`ts/util/countUnreadStats.std.ts` — add a trailing parameter to
`countAllChatFoldersUnreadStats` and pass it through:

```ts
export function countAllChatFoldersUnreadStats(
  currentChatFolders: CurrentChatFolders,
  conversations: ReadonlyArray<ConversationPropsForUnreadStats>,
  hiddenFromAllChatsConversationIds?: ReadonlySet<string>
): AllChatFoldersUnreadStats {
  // ...
      if (
        isConversationInChatFolder(chatFolder, conversation, {
          hiddenFromAllChatsConversationIds,
        })
      ) {
```

`ts/util/countMutedStats.std.ts` — the same shape for
`countAllChatFoldersMutedStats`.

`ts/state/selectors/conversations.dom.ts:423` — the selector that owns this call
must take `getHiddenFromAllChatsConversationIds` as an input selector and pass
the set in the options bag. **Leave the `stableSelectedConversationIdInChatFolder`
early-return above it untouched** — that is Review Focus item 5, and it is what
stops an open chat vanishing mid-read.

`ts/state/ducks/conversations.preload.ts:1479` — in
`_getAllConversationsInChatFolder`, read the set from state and pass it:

```ts
  const hiddenFromAllChatsConversationIds =
    getHiddenFromAllChatsConversationIds(state);
  return allConversations.filter(conversation => {
    return isConversationInChatFolder(chatFolder, conversation, {
      hiddenFromAllChatsConversationIds,
    });
  });
```

`ts/state/ducks/chatFolders.preload.ts:292` — same pattern, read from `state`.

**Do not touch** `ts/components/leftPane/LeftPaneConversationListItemContextMenu.dom.tsx:371`.
It asks "is this chat a member of folder X" to drive menu actions; membership is
the right answer there, visibility is not.

- [x] **Step 9: Verify, including the upstream suite**

```sh
pnpm run check:types
pnpm run oxlint
pnpm run test-node
```

Every upstream chat folder test must still pass **without being edited**. If one
fails, the change was not additive — fix the change, not the test.

- [x] **Step 10: Commit**

```sh
git add ts/types/ChatFolder.std.ts ts/state/selectors ts/state/ducks \
        ts/util/countUnreadStats.std.ts ts/util/countMutedStats.std.ts \
        ts/test-node/types/trukiHideFromAllChats_test.std.ts
git commit -m "truki(spaces): let a space hide its members from General"
```

---

## Task 5: Accent theming

**Files:**
- Create: `stylesheets/_truki-spaces.scss`
- Create: `ts/hooks/useTrukiSpaceAccent.dom.ts`
- Modify: `stylesheets/manifest.scss` (one `@use`/`@import` line)
- Modify: `ts/state/smart/LeftPane.preload.tsx` (call the hook)

**Interfaces:**
- Consumes: `TrukiSpaceColor.toCssHex` from Task 1, `getSelectedChatFolder`
  from `ts/state/selectors/chatFolders.std.ts`.
- Produces: `useTrukiSpaceAccent(color: number | null): void`

- [x] **Step 1: Write the stylesheet**

Create `stylesheets/_truki-spaces.scss`:

```scss
// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Truki: the selected space's accent. One variable is set on <body> by
// useTrukiSpaceAccent; every Axo accent token is derived from it here, so there
// is no JS colour maths and no extra stored shades.
//
// No attribute means no override, which is stock Signal blue. A user who never
// sets a space colour sees no change at all.

body[data-truki-space-accent] {
  --axo-color-fill-accent: var(--truki-space-accent);
  --axo-color-fill-accent-pressed: color-mix(
    in oklab,
    var(--truki-space-accent) 88%,
    black
  );
  --axo-color-fill-accent-bright: color-mix(
    in oklab,
    var(--truki-space-accent) 45%,
    white
  );
  --axo-color-fill-accent-bright-pressed: color-mix(
    in oklab,
    var(--truki-space-accent) 38%,
    white
  );
  --axo-color-fill-accent-tint: color-mix(
    in oklab,
    var(--truki-space-accent) 10%,
    transparent
  );
  --axo-color-fill-accent-tint-pressed: color-mix(
    in oklab,
    var(--truki-space-accent) 16%,
    transparent
  );
  --axo-color-label-accent: color-mix(
    in oklab,
    var(--truki-space-accent) 85%,
    black
  );
}

body[data-truki-space-accent].dark-theme {
  --axo-color-label-accent: color-mix(
    in oklab,
    var(--truki-space-accent) 70%,
    white
  );
}
```

Before writing it, confirm the exact token names still match:

```sh
grep -n "axo-color-fill-accent\|axo-color-label-accent" ts/axo/_tailwind-theme/colors.css
```

If a token in the list above does not exist, drop it. If one exists that is not
listed, add it. **Do not edit `colors.css` itself** — it is an upstream file.

- [x] **Step 2: Register the stylesheet**

In `stylesheets/manifest.scss`, add the new partial alongside the existing
imports, following whatever syntax that file already uses (`@use` or `@import`).
Add it **last** among the Truki-relevant entries so its overrides win.

- [x] **Step 3: Write the hook**

Create `ts/hooks/useTrukiSpaceAccent.dom.ts`:

```ts
// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect } from 'react';

import * as TrukiSpaceColor from '../types/TrukiSpaceColor.std.ts';

const ATTRIBUTE = 'data-truki-space-accent';
const VARIABLE = '--truki-space-accent';

/**
 * Applies the selected space's accent colour to <body>. Removing the attribute
 * restores stock Signal blue, because the override block in
 * stylesheets/_truki-spaces.scss is scoped to its presence.
 */
export function useTrukiSpaceAccent(color: number | null): void {
  useEffect(() => {
    const { body } = document;

    if (color == null) {
      body.removeAttribute(ATTRIBUTE);
      body.style.removeProperty(VARIABLE);
      return undefined;
    }

    body.setAttribute(ATTRIBUTE, '');
    body.style.setProperty(VARIABLE, TrukiSpaceColor.toCssHex(color));

    return () => {
      body.removeAttribute(ATTRIBUTE);
      body.style.removeProperty(VARIABLE);
    };
  }, [color]);
}
```

- [x] **Step 4: Call it**

In `ts/state/smart/LeftPane.preload.tsx`, inside the component, add:

```ts
const selectedChatFolder = useSelector(getSelectedChatFolder);
useTrukiSpaceAccent(selectedChatFolder?.color ?? null);
```

If `selectedChatFolder` is already selected in that component, reuse it rather
than selecting it twice.

- [x] **Step 5: Verify the cascade** *(done 2026-09-25 — see note below)*

The mechanism was verified in a real browser instead of by eye, by loading
`manifest.css` and `tailwind.css` in the same order `background.html` does and
reading the painted colour off a probe element:

| state | `--axo-color-fill-accent` painted |
| --- | --- |
| no attribute | `rgb(70, 85, 255)` — stock Signal blue |
| attribute + `#3a7d44` | `rgb(58, 125, 68)` — the space colour |
| attribute removed | `rgb(70, 85, 255)` — restored |

This matters because the base token is defined in `tailwind.css`, which loads
*after* `manifest.css`. The override wins on specificity
(`body[data-truki-space-accent]` over `:root`) rather than on order, and the
test confirms that rather than assuming it.

**Still outstanding:** an in-app visual pass. Do it at the end of Task 7, when
the colour picker exists and a colour can be set through the UI rather than the
dev console.

<details><summary>Original step text</summary>

```sh
pnpm run check:types
pnpm run oxlint
pnpm start
```

There is no colour picker yet (Task 7), so set one by hand to see it work:
open the app, then in the dev console run

```js
document.body.setAttribute('data-truki-space-accent', '');
document.body.style.setProperty('--truki-space-accent', '#3a7d44');
```

Expected: the compose button, selected chat row and links turn green. Remove the
attribute and they return to blue. If nothing changes, the stylesheet is not
being loaded — check the `manifest.scss` entry and that the build regenerated
`stylesheets/manifest.css`.

</details>

- [x] **Step 6: Commit**

```sh
git add stylesheets/_truki-spaces.scss stylesheets/manifest.scss \
        ts/hooks/useTrukiSpaceAccent.dom.ts ts/state/smart/LeftPane.preload.tsx
git commit -m "truki(spaces): apply the selected space's accent colour"
```

---

## Task 6: Space bar in the left pane header

**Files:**
- Create: `ts/components/leftPane/TrukiSpaceBar.dom.tsx`
- Create: `ts/components/leftPane/TrukiSpaceBar.dom.stories.tsx`
- Modify: `ts/components/NavSidebar.dom.tsx` (~line 216, optional `titleSlot`)
- Modify: `ts/components/LeftPane.dom.tsx` (~line 809, pass `titleSlot`)
- Modify: `ts/components/leftPane/LeftPaneInboxHelper.dom.tsx:147`
- Modify: `ts/state/smart/LeftPane.preload.tsx` (render the bar)
- Modify: `_locales/en/messages.json`

**Interfaces:**
- Consumes: `ChatFolder` fields from Task 1, `TrukiSpaceColor.toCssHex`.
- Produces: `TrukiSpaceBar` — props mirror `LeftPaneChatFoldersProps` in
  `ts/components/leftPane/LeftPaneChatFolders.dom.tsx`, which already receives
  everything needed. Read that file first and reuse its prop shape verbatim.

- [ ] **Step 1: Add the optional slot to NavSidebar**

In `ts/components/NavSidebar.dom.tsx`, add to the props type, next to
`title: string;`:

```ts
  /** Truki: replaces the <h1> title when provided. Chats tab only. */
  titleSlot?: ReactNode;
```

Destructure it alongside `title`, then change the `<h1>` block (~line 216) to:

```tsx
                {titleSlot ?? (
                  <h1
                    className={classNames('NavSidebar__HeaderTitle', {
                      'NavSidebar__HeaderTitle--withBackButton': onBack != null,
                    })}
                    aria-live="assertive"
                  >
                    {title}
                  </h1>
                )}
```

The `<h1>` markup itself is unchanged — it is only wrapped. Every other
`NavSidebar` consumer passes no `titleSlot` and is unaffected.

- [ ] **Step 2: Write the component's Storybook stories first**

Create `ts/components/leftPane/TrukiSpaceBar.dom.stories.tsx` covering
**Review Focus items 3 and 4**:

```tsx
// Stories to write:
//  - Default:            General selected, two custom spaces collapsed
//  - WithColors:         each space a different palette colour
//  - NoEmoji:            a space named 'Gaming' with emoji null -> pill shows 'G'
//  - GeneralNotRenamed:  General with name '' and emoji null, collapsed
//                        -> pill must show the i18n label's first grapheme,
//                           NOT a blank pill
//  - MultiCodepointEmoji: emoji '👨‍👩‍👧‍👦' and a space named '🇪🇪Eesti' with no emoji
//                        -> neither is split into a broken half
//  - LongName:           a 32-character name, selected -> truncates, no overflow
//  - ManySpaces:         ten spaces -> bar scrolls horizontally
```

Model the story file's boilerplate on `LeftPane.dom.stories.tsx`.

- [ ] **Step 3: Write the component**

Create `ts/components/leftPane/TrukiSpaceBar.dom.tsx`.

Read `ts/components/leftPane/LeftPaneChatFolders.dom.tsx` first and lift its
prop type, its `getBadgeValue`, its `getChatFolderLabel`, its context menu and
its `handleFocus` scroll behaviour. **Copy them into the new file rather than
importing from it** — upstream owns that file and will keep changing it;
copying keeps Truki's merge surface at zero. Copying here is the cheaper trade,
against this repo's prime directive.

Behaviour:

- Render a horizontally scrollable row of pills, sorted by
  `CurrentChatFolders.toSortedArray`.
- **Selected pill:** expanded — icon + label. Background is the space's colour
  via inline `style={{ backgroundColor: TrukiSpaceColor.toCssHex(color) }}`
  when set, otherwise the Axo accent token.
- **Unselected pill:** collapsed — icon only, plus the unread badge when
  non-zero. Its accessible name is still the full label.
- **Icon resolution**, in order: the space's `emoji`; otherwise the first
  grapheme of its resolved display label.

  ```ts
  import * as grapheme from '../../util/grapheme.std.ts';

  function getSpaceIcon(chatFolder: ChatFolder, label: string): string {
    if (chatFolder.emoji != null && chatFolder.emoji !== '') {
      return chatFolder.emoji;
    }
    // Must be grapheme-aware: 'label[0]' splits flags, ZWJ families and skin
    // tones into broken halves. truncateAndSize returns [text, size].
    const [firstGrapheme] = grapheme.truncateAndSize(label, 1);
    return firstGrapheme;
  }
  ```

  `truncateAndSize` is the only helper `ts/util/grapheme.std.ts` exports that
  yields the first N graphemes — there is no `take`. The others are `count` and
  `hasAtMostGraphemes`, neither of which fits.

  `label` must be the **resolved** display string, so General with `name === ''`
  yields the i18n label's first grapheme, never an empty pill.
- Keep each pill's context menu: mark read, mute submenu, open settings.
- Do not render at all when `!currentChatFolders.hasAnyCurrentCustomChatFolders`,
  matching upstream — a user with no custom spaces keeps the plain "Chats" title.

- [ ] **Step 4: Check the stories**

```sh
pnpm run storybook
```

Walk every story. Confirm specifically: `GeneralNotRenamed` shows a letter, not
a blank; `MultiCodepointEmoji` shows whole glyphs; `LongName` truncates without
pushing the actions off the header.

- [ ] **Step 5: Wire it in**

In `ts/state/smart/LeftPane.preload.tsx`, add a `renderTrukiSpaceBar` render
prop beside the existing `renderLeftPaneChatFolders`, feeding `TrukiSpaceBar`
the same selectors `SmartLeftPaneChatFolders` uses.

In `ts/components/LeftPane.dom.tsx` (~line 809), pass it:

```tsx
      titleSlot={renderTrukiSpaceBar()}
```

In `ts/components/leftPane/LeftPaneInboxHelper.dom.tsx:147`, stop rendering the
old strip:

```ts
    // Truki: the space selector lives in the header now, see TrukiSpaceBar.
    return null;
```

Leave the `renderLeftPaneChatFolders` render prop and its plumbing in place,
unused. Deleting it is a bigger upstream diff than leaving it.

- [ ] **Step 6: Keep the narrow-width fallback**

At `WidthBreakpoint.Narrow`, `TrukiSpaceBar` must fall back to upstream's
`AxoSelect` dropdown — copy that branch from `LeftPaneChatFolders.dom.tsx`. The
header is too tight for pills at narrow widths.

Verify by dragging the left pane to its minimum width.

- [ ] **Step 7: Verify**

```sh
pnpm run check:types
pnpm run oxlint
pnpm run test-node
pnpm start
```

In the app: create two chat folders in settings, confirm the pills appear in the
header where "Chats" was, that selecting one expands it and collapses the other,
and that the old strip below the search box is gone.

- [ ] **Step 8: Commit**

```sh
git add ts/components/leftPane/TrukiSpaceBar.dom.tsx \
        ts/components/leftPane/TrukiSpaceBar.dom.stories.tsx \
        ts/components/NavSidebar.dom.tsx ts/components/LeftPane.dom.tsx \
        ts/components/leftPane/LeftPaneInboxHelper.dom.tsx \
        ts/state/smart/LeftPane.preload.tsx _locales/en/messages.json
git commit -m "truki(spaces): move the space selector into the left pane header"
```

---

## Task 7: Settings — icon, colour, hide checkbox, editable General

**Files:**
- Create: `ts/components/preferences/chatFolders/TrukiSpaceColorPicker.dom.tsx`
- Modify: `ts/components/preferences/chatFolders/PreferencesEditChatFoldersPage.dom.tsx`
- Modify: `ts/components/preferences/chatFolders/PreferencesChatFoldersPage.dom.tsx`
- Modify: `ts/state/smart/PreferencesEditChatFolderPage.preload.tsx`
- Modify: `_locales/en/messages.json`

**Interfaces:**
- Consumes: `PALETTE`, `toCssHex` from `ts/types/TrukiSpaceColor.std.ts`;
  `ChatFolderParams` with `emoji`/`color`/`hideFromAllChats`.
- Produces: `TrukiSpaceColorPicker` — `{ value: number | null; onChange: (value: number | null) => void; i18n: LocalizerType }`

- [ ] **Step 1: Write the colour picker**

Create `ts/components/preferences/chatFolders/TrukiSpaceColorPicker.dom.tsx`: a
row of round swatches over `TrukiSpaceColor.PALETTE`, plus a "no colour" option
that sets `null`. Selected swatch gets a ring. Each swatch is a `<button
type="button">` with an `aria-label`, and the row is keyboard navigable.

Style with `tw()` and inline `backgroundColor` from `toCssHex`.

- [ ] **Step 2: Add the three controls to the edit page**

In `PreferencesEditChatFoldersPage.dom.tsx`:

- **Icon** — reuse the emoji picker that
  `ts/components/PreferencesNotificationProfiles.dom.tsx` uses:

  ```tsx
  import { FunEmojiPicker } from '../../fun/FunEmojiPicker.dom.tsx';
  import { FunEmojiPickerButton } from '../../fun/FunButton.dom.tsx';
  ```

  Read lines ~561–645 of that file for the exact open-state and
  `onSelectEmoji` wiring, and mirror it. Fix the relative import depth.
- **Colour** — `TrukiSpaceColorPicker`, bound to `params.color`.
- **Hide from General** — a checkbox bound to `params.hideFromAllChats`,
  labelled with a new string:

  ```json
  "icu:Preferences__EditChatFolderPage__HideFromGeneral__Label": {
    "messageformat": "Hide these chats from General",
    "description": "Checkbox label. When on, this space's chats do not appear in the General space."
  },
  "icu:Preferences__EditChatFolderPage__HideFromGeneral__Unavailable": {
    "messageformat": "Not available for spaces that include all chats of a type",
    "description": "Explains why the hide-from-General checkbox is disabled."
  }
  ```

  Match the surrounding checkbox markup already in the file.

  **The checkbox must be disabled** whenever `params.includeAllIndividualChats`
  or `params.includeAllGroupChats` is set, showing the `__Unavailable` string
  underneath. Those spaces claim members by rule rather than by id, and the
  hidden-set selector in Task 4 reads `includedConversationIds` only — so
  ticking it would silently do nothing. See §5.2 of the spec. Disabling it is
  the honest behaviour; making it work would require the derived-state churn the
  spec rejects.

All three feed the same `ChatFolderParams` the page already tracks, so save and
validation need no changes.

- [ ] **Step 3: Make General editable**

In `PreferencesChatFoldersPage.dom.tsx` (~line 419), the ALL folder currently
renders as a non-interactive `ListBoxItem`. Give it the same
`onClick={handleClickChatFolder}` the CUSTOM branch uses, so it opens the edit
page. Keep its delete action absent.

In `PreferencesEditChatFoldersPage.dom.tsx`, when
`chatFolder.folderType === ChatFolderType.ALL`:

- **Show:** name, icon, colour.
- **Hide:** every filter section (included/excluded chats, show-only-unread,
  show-muted, and the hide-from-General checkbox — meaningless on General).
- **Hide:** the delete button.

Use the existing `ChatFolderType.ALL` check at line 419 as the model.

On save, General must keep its filter params locked. Confirm the save path
spreads `ALL_CHATS_FOLDER_REQUIRED_PARAMS` over the filter fields for ALL
folders, and add that spread if it does not.

- [ ] **Step 4: Add the remaining strings**

Add to `_locales/en/messages.json`, matching the file's existing key style:

```json
"icu:Preferences__EditChatFolderPage__Icon__Label": {
  "messageformat": "Icon",
  "description": "Label for the emoji picker that sets a space's icon."
},
"icu:Preferences__EditChatFolderPage__Color__Label": {
  "messageformat": "Color",
  "description": "Label for the colour picker that sets a space's accent colour."
},
"icu:Preferences__EditChatFolderPage__Color__None": {
  "messageformat": "Default",
  "description": "Colour picker option meaning the space uses the default accent."
}
```

Do not edit any other locale file.

- [ ] **Step 5: Verify end to end**

```sh
pnpm run check:types
pnpm run oxlint
pnpm run test-node
pnpm start
```

Walk the whole feature:

1. Create a space, give it a name, an emoji and a colour. → its pill appears in
   the header with that emoji; selecting it retints the UI.
2. Create a second space with no emoji. → its collapsed pill shows the first
   letter of its name.
3. Rename General to "Home", give it an icon and a colour. → the header pill
   updates; General still lists every chat; it has no delete button.
4. Add a chat to a space, tick "Hide these chats from General". → the chat
   disappears from General and General's unread badge drops accordingly.
5. Open that hidden chat, then switch to General. → it does not vanish from
   under you while open (Review Focus item 5).
6. Untick the box. → the chat returns to General.
7. Delete a space that was hiding chats. → its chats return to General
   (Review Focus item 2).
8. Restart the app. → every name, icon, colour and checkbox survives.

- [ ] **Step 6: Commit**

```sh
git add ts/components/preferences/chatFolders _locales/en/messages.json \
        ts/state/smart/PreferencesEditChatFolderPage.preload.tsx
git commit -m "truki(spaces): add icon, colour and hide-from-General settings"
```

---

## Final verification

- [ ] **Full suite**

```sh
pnpm run check:types
pnpm run oxlint
pnpm run test-node
pnpm run test-electron
```

- [ ] **Upstream diff audit** — the whole point of the design:

```sh
git diff --stat v8.27.0..HEAD -- ts protos stylesheets _locales
```

Confirm against the spec's file inventory: roughly 6 new files and 17 modified
upstream files, **no upstream file rewritten, no upstream test edited**. If an
upstream file shows a large diff, look at whether that change could have lived
in a new file instead.

- [ ] **Confirm no schema version was added:**

```sh
git diff v8.27.0..HEAD -- ts/sql/migrations/index.node.ts
```

Expected: exactly two added lines — the import and the `ensureTrukiSchema(db, logger)`
call. Anything touching `SCHEMA_VERSIONS` is a bug that will break every future
upstream merge.
