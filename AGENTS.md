# AGENTS.md — working in the Truki fork

Truki is a fork of Signal Desktop, currently based on upstream `v8.27.0`.
Read this before changing anything.

## The prime directive

**Upstream ships roughly weekly, and Truki must re-merge cheaply.** Every line
Truki changes in an upstream file is a line that can conflict on every future
merge, forever.

So: prefer the design that touches fewer upstream lines, even when it is less
elegant. A feature that works and merges cleanly beats a feature that is
beautifully factored and conflicts every week.

### Rules that follow from it

1. **Put new behaviour in new files.** A new file has zero conflict surface.
2. **Make edits to upstream files additive.** New optional parameters, new
   optional props, new columns, new branches. An upstream function must behave
   exactly as before when the new inputs are absent.
3. **Never delete or rewrite upstream logic.** If upstream code is in the way,
   add a branch around it rather than replacing it.
4. **Never reformat, reorder, or "tidy" upstream code.** Do not fix unrelated
   lint, do not reorder imports, do not rename upstream symbols. A whitespace
   change in an upstream file is a merge conflict for no benefit.
5. **Keep upstream naming.** Truki says "Space" to the user, but the code keeps
   upstream's `chatFolder` names so upstream patches still apply.
6. **Touch as few upstream files as the task allows.** If a change needs edits
   in eight upstream files, stop and look for a design that needs three.

## Numbering spaces upstream also allocates from

Upstream hands out numbers from shared counters. Truki must never take one, or
a future upstream release will collide with it.

### SQL schema versions — do not add one

**Never add an entry to `SCHEMA_VERSIONS` in `ts/sql/migrations/index.node.ts`.**

The runner skips any migration whose version is `<= user_version`. A Truki
migration numbered above upstream's range makes every *future upstream*
migration silently skip on Truki installs, which corrupts the schema. A Truki
migration inside upstream's range collides with upstream's next release.

Truki schema changes go in `ts/sql/truki/ensureTrukiSchema.node.ts`, which runs
after upstream's migration loop, inspects `PRAGMA table_info(...)`, adds only
what is missing, and never writes `user_version`. It must stay idempotent:
running it twice, or on an already-current database, must be a no-op.

### Protobuf field numbers — use 20001+

Upstream continues numbering from wherever it left off. **All Truki protobuf
fields use field numbers `>= 20001`.** Protobuf reserves 19000–19999, so 20001
is the first safe number. Leave a comment marking the Truki block.

Unknown protobuf fields are round-tripped by Signal clients
(`fromStorageUnknownFields` / `$unknown`), so Truki fields survive being
written by an official client. Do not add a field without checking the record's
`$unknown` handling is preserved.

### Other shared counters

Same rule applies to anything upstream increments: job types, storage keys,
IPC channel names. Prefix Truki's with `truki` and keep them out of upstream's
sequence.

## Things that will bite you

- **The app name must stay ASCII.** With a non-ASCII `productName`, Electron's
  privileged protocols (`attachment:`, `asset:`) fail with `net::ERR_UNEXPECTED`
  before reaching the handler, and photos, avatars and stickers silently fall
  back to placeholders. Do not "fix" the name.
- **`config/production.json` carries Truki's update URL and signing key.** On an
  upstream merge, keep Truki's side of this file and of `package.json` identity
  fields. Take upstream's side everywhere else.
- **Editing an upstream test is a red flag.** If a change makes an upstream test
  fail, the change was not additive. Fix the change, not the test.

## Verification — run before claiming anything works

```sh
pnpm run check:types      # tsc --noEmit
pnpm run oxlint
pnpm run test-node
```

### Known pre-existing failures — leave them alone

These are already broken on `main`, are unrelated to any current work, and must
not be "fixed" as a drive-by:

`check:types` — 2 errors:

```
ts/updater/got.main.ts(5,8): TS6133: 'config' is declared but its value is never read.
ts/windows/main/attachments.preload.ts(205,32): TS2307: Cannot find module 'fs-xattr'
```

`fs-xattr` is a macOS-only optional dependency, absent on Windows.

`oxlint` — 12 errors, 11 of them unused `oxlint-disable` directives:

```
ts/util/showConfirmationDialog.dom.tsx    1
ts/util/longRunningTaskWrapper.dom.tsx    1
ts/util/createIdenticon.preload.tsx       1
ts/util/groupAndOrderReactions.std.ts     1
ts/util/timelineUtil.std.ts               3
ts/util/getGroupMemberships.dom.ts        2
scripts/generate-db-schema.mjs            2
ts/updater/got.main.ts                    1   (no-unused-vars, same 'config' import)
```

Treat the tree as clean when exactly these remain. **Both commands exit
non-zero regardless — read the output, never the exit code.**

Count them before assuming a new failure is yours. Equally, do not assume a
number quoted in a plan is right: re-measure, and say so if it differs.

### Windows environment

- PowerShell may block `pnpm.ps1`. Use `pnpm.cmd`.
- An inherited `ELECTRON_RUN_AS_NODE=1` breaks `test-node` — electron-mocha
  needs Electron's `app`, and you get
  `TypeError: Cannot read properties of undefined (reading 'getPath')`.

  The variable must be **removed**, not blanked. `ELECTRON_RUN_AS_NODE= pnpm ...`
  still counts as set and fails identically. Use:

  ```sh
  env -u ELECTRON_RUN_AS_NODE pnpm.cmd run test-node
  ```

  A healthy run is ~2400 passing, 12 pending.
- Stopping a running Storybook is required before `pnpm install` can replace
  native modules; Windows will not overwrite a loaded `.node` file.
- **Storybook's script is `pnpm run dev`**, not `pnpm run storybook` — that name
  does not exist and pnpm will suggest `test:storybook`, which is the CI runner,
  not the dev server. It serves on port 6006 and takes a minute or two to
  compile after the process starts, so poll
  `curl -sf http://127.0.0.1:6006/` rather than trusting the log.

Report what actually ran and what it printed. **Never claim a command passed
without running it.** If something fails and you cannot fix it, say so plainly
and stop — do not describe the work as complete.

### Quote the summary line, do not characterise it

For every verification command, **paste its literal final summary line** into
your report:

```
✖ 15 problems (15 errors, 0 warnings)      <- oxlint
2417 passing (56s) / 12 pending            <- test-node
```

Do not write "emitted zero diagnostics", "no failure report", "completed
successfully" or any other paraphrase. Those have each been wrong here: a run
reported as "zero diagnostics" was in fact 15 errors, three of them newly
introduced by that very task.

If a runner swallowed the totals, **re-run it until you have them.** A run whose
result you could not read is a run that did not happen. Say "I could not obtain
the totals" rather than describing the outcome you assume.

The baseline counts above are what "clean" means. If your number is higher, the
extra ones are yours — find them with:

```sh
pnpm.cmd run oxlint 2>&1 | grep -c error
```

For anything touching SQL, storage service, or the left pane, also run:

```sh
pnpm run test-electron
```

## Conventions

- File suffixes are load-bearing: `.std.ts` (environment-agnostic), `.dom.tsx`
  (renderer), `.preload.ts` (preload), `.node.ts` (main/SQL). Put new files in
  the right one; the linter enforces the import graph.
- New UI goes through the Axo design system (`ts/axo/`) and `tw()`, not new
  SCSS, unless overriding a CSS custom property is the point.
- New user-facing strings go in `_locales/en/messages.json` with an `icu:` key.
  Do not hand-edit other locales.
- Match the surrounding code's style. Do not introduce new patterns.

### Naming Truki-owned files

**Every Truki-owned file must have a `truki` path segment, or `truki`/`Truki`
somewhere in its filename** — `ts/sql/truki/ensureTrukiSchema.std.ts`,
`ts/types/TrukiSpaceColor.std.ts`, `scripts/truki-sign-windows.mjs`,
`ts/test-node/sql/ensureTrukiSchema_test.node.ts`.

Two reasons. It makes Truki's whole footprint greppable when merging upstream,
and `.oxlintrc.json` keys its Truki lint override off exactly this convention.
A Truki file named otherwise will fail lint.

Anywhere in the name counts, so pick the name that reads best. Do not stutter a
prefix onto a name that already contains it — `ensureTrukiSchema_test.node.ts`,
never `trukiEnsureTrukiSchema_test.node.ts`.

### Copyright headers

Truki-owned files use:

```
// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only
```

Upstream's `enforce-license-comments` rule demands
`/^ Copyright \d{4} Signal Messenger, LLC$/` exactly, which a fork's own files
cannot satisfy without misattributing authorship to Signal. `.oxlintrc.json`
therefore disables that one rule for Truki-owned paths. **Do not "fix" a Truki
header to say Signal Messenger, LLC**, and do not edit the rule itself.

When editing an *upstream* file, leave its existing Signal header alone.

### File suffixes are derived, not chosen

`enforce-file-suffix` infers the correct suffix from what a file imports, so a
file using no node-only API must be `.std.ts` even when it lives under `ts/sql/`.
If lint reports `Invalid suffix`, rename the file to what it asks for rather
than adding an ignore.

## Scope discipline

Do the task in the plan and stop. If you find an unrelated bug, a tempting
refactor, or dead code, **mention it and leave it alone.** Unrequested changes
to upstream files are the single most expensive thing you can do in this repo.

If the plan turns out to be wrong or impossible, stop and say so with the
specific reason. Do not improvise a different design.
