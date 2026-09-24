# Truki Spaces — Design

Status: approved 2026-09-24
Fork base: upstream Signal Desktop `v8.27.0`

## 1. Purpose

Let a user organise conversations into **Spaces**: a permanent "General" space
plus any number of user-created spaces, each with its own name, icon, accent
colour, and the option to keep its members out of General.

## 2. Prime constraint

Truki must stay cheap to re-merge against upstream Signal, which ships roughly
weekly. **Every design decision below trades features for a smaller upstream
diff.** Where two designs are equivalent in user-visible behaviour, the one
that touches fewer upstream lines wins.

Concretely, the rules this spec follows:

- New behaviour lives in **new files** wherever possible.
- Changes to upstream files are **additive**: new optional parameters, new
  optional props, new columns. No upstream function changes its existing
  behaviour when the new inputs are absent.
- No upstream logic is deleted or rewritten.
- Truki must never occupy a numbering space upstream also allocates from
  (SQL schema versions, protobuf field numbers).

## 3. Foundation: extend upstream Chat Folders

Upstream v8.27 already ships Chat Folders, which provide most of Spaces:

| Requirement | Upstream status |
| --- | --- |
| A permanent, undeletable "everything" container | Exists — `ChatFolderType.ALL` |
| User-created containers | Exists — `ChatFolderType.CUSTOM` |
| Assign conversations to a container | Exists — `includedConversationIds` / `excludedConversationIds` |
| Reorder containers | Exists — `position` + drag handle |
| Mute a container | Exists — bulk mute of member chats |
| Sync to phone | Exists — `ChatFolderRecord` storage service |
| Per-container colour | **Missing** |
| Per-container icon | **Missing** |
| Rename the "everything" container | **Missing** |
| Hide a container's members from "everything" | **Missing** |

Spaces are therefore a **thin Truki layer on Chat Folders**, not a parallel
system. "Space" is user-facing vocabulary; the code keeps upstream's
`chatFolder` names throughout so that upstream diffs continue to apply cleanly.

### 3.1 Rejected alternative

Suppressing upstream's ALL folder and substituting a Truki-owned, fully
editable "General" custom folder was considered and rejected:

- The ALL folder is force-created by SQL and re-upserted on every storage
  sync (`upsertAllChatsChatFolderFromSync`), so it reappears after suppression.
- `CurrentChatFolders` types it as guaranteed present, so removing it means
  changing a type every downstream selector depends on.
- It is special-cased in backup export/import, `storageRecordOps`, and four UI
  branch points.
- It would still sync, so the phone would show both "All chats" and "General".
- Hiding members would become derived state: General's `excludedConversationIds`
  would need continuous recomputation from every other space's membership, and
  that churn would be written to the phone on every membership change.

Keeping the ALL folder and adding a boolean is strictly smaller.

## 4. Data model

### 4.1 New fields

Three fields are added to the chat folder record:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `emoji` | `string \| null` | `null` | Icon shown on the space pill. When null the pill falls back to the first grapheme of `name`. |
| `color` | `number \| null` | `null` | Accent colour as `0xAARRGGBB`. When null the space uses stock Signal blue. |
| `hideFromAllChats` | `boolean` | `false` | When true, this space's member conversations are omitted from the General space. |

`emoji` and `color` mirror `NotificationProfile`, which already stores exactly
these two field types and already has picker UI that can be reused.

### 4.2 The General space

General is upstream's `ChatFolderType.ALL` folder, with its editability widened:

- **Editable:** `name`, `emoji`, `color`.
- **Locked:** every filter field, still forced by
  `ALL_CHATS_FOLDER_REQUIRED_PARAMS`. General can never stop meaning
  "everything" (subject to `hideFromAllChats` on other spaces).
- **Undeletable:** unchanged from upstream.

`name` on the ALL folder is `''` upstream, and the label is supplied by i18n.
After this change, a non-empty `name` is displayed if set; `''` continues to
fall back to the i18n string. Existing installs therefore render identically
until the user renames it.

### 4.3 SQLite columns

```sql
ALTER TABLE chatFolders ADD COLUMN emoji TEXT;
ALTER TABLE chatFolders ADD COLUMN color INTEGER;
ALTER TABLE chatFolders ADD COLUMN hideFromAllChats INTEGER NOT NULL DEFAULT 0;
```

### 4.4 Schema installation — deliberately outside the migration system

**Truki must not add a numbered migration to `SCHEMA_VERSIONS`.**

The migration runner skips any migration whose version is `<= user_version`
(`ts/sql/migrations/index.node.ts`). A Truki migration numbered above upstream's
range would therefore cause every *future upstream* migration to be silently
skipped on Truki installs, producing schema drift and eventual crashes. A Truki
migration numbered inside upstream's range collides with upstream's next
release and creates the same skip hazard for whichever migration loses.

Instead the columns are installed by an **idempotent ensure step** that runs
after upstream's migration loop and never touches `user_version`:

```
ts/sql/truki/ensureTrukiSchema.node.ts   (new file)

export function ensureTrukiSchema(db, logger): void {
  // PRAGMA table_info(chatFolders) -> add only columns that are absent
}
```

Called from the end of `updateSchema` in `ts/sql/migrations/index.node.ts`, so
both the app (`Server.node.ts:1054`) and the test harness (`setupTests`) pick
it up.

Properties this buys:

- **Zero merge conflicts** in the `SCHEMA_VERSIONS` array — the file upstream
  edits on almost every release.
- Upstream migrations keep running normally on Truki installs, forever.
- Self-healing: if a column is ever lost, the next launch restores it.
- Re-running is always a no-op.

### 4.5 Protobuf

`ChatFolderRecord` in `protos/SignalStorage.proto` currently uses field numbers
1–11.

```proto
message ChatFolderRecord {
  // ... upstream fields 1-11 unchanged ...

  // Truki extensions. Field numbers >= 20001 are reserved for Truki so that
  // upstream additions (which continue from 12) can never collide.
  optional string emoji     = 20001;
  fixed32 color             = 20002;  // 0xAARRGGBB, 0 means unset
  bool hideFromAllChats     = 20003;
}
```

Protobuf reserves 19000–19999 for its own use, so the Truki block starts at
20001.

### 4.6 Sync behaviour

The new fields sync to the phone through the existing storage service path.
This is safe because Signal clients **round-trip unknown protobuf fields**:
`toChatFolderRecord` re-attaches `$unknown` via `fromStorageUnknownFields`, and
official Signal mobile/iOS do the same. A Truki space's colour therefore
survives being written by an official client that has no concept of colours.

`color = 0` is the wire representation of "unset", because proto3 scalar
`fixed32` has no presence. `emoji` is `optional` so it has real presence.

## 5. Hiding members from General

### 5.1 Mechanism

`isConversationInChatFolder` already accepts an options bag. One optional field
is added to it, and the ALL branch changes from an unconditional `true`:

```ts
export type ChatFolderConversationFilterOptions = Readonly<{
  ignoreShowOnlyUnread?: boolean;
  ignoreShowMutedChats?: boolean;
  hiddenFromAllChatsConversationIds?: ReadonlySet<string>;  // new
}>;

export function isConversationInChatFolder(chatFolder, conversation, options = {}) {
  if (chatFolder.folderType === ChatFolderType.ALL) {
    // was: return true;
    return !options.hiddenFromAllChatsConversationIds?.has(conversation.id);
  }
  // ...unchanged...
}
```

Because the option is optional, every existing call site and every upstream
test compiles unchanged and behaves identically: `!undefined?.has(x)` is `true`,
which is today's behaviour.

### 5.2 The hidden set

A new memoized selector derives the set from the folders themselves:

```
getHiddenFromAllChatsConversationIds(state): ReadonlySet<string>
  = union of member conversation ids of every non-deleted CUSTOM folder
    whose hideFromAllChats is true
```

It is derived, never stored, so it cannot drift out of sync with membership.

**Limitation — hiding covers explicitly-added members only.** The set is built
from `includedConversationIds`. A space defined by `includeAllIndividualChats`
or `includeAllGroupChats` claims its members by rule rather than by id, and the
selector has no conversation list to expand that rule against. Ticking
"hide from General" on such a space therefore hides nothing.

The UI must not silently do nothing: in the edit page, the checkbox is disabled
with an explanatory note whenever either `includeAll*` flag is set. Resolving
this properly would mean expanding the rule against every conversation on each
membership change, which is the derived-state churn §3.1 rejects.

### 5.3 Call sites

| Call site | Threaded? | Why |
| --- | --- | --- |
| `state/selectors/conversations.dom.ts:423` | yes | the General chat list itself |
| `util/countUnreadStats.std.ts:224` | yes | badge counts must match the list |
| `util/countMutedStats.std.ts:45` | yes | muted stats must match the list |
| `state/ducks/conversations.preload.ts:1479` | yes | scopes mark-read and bulk mute |
| `state/ducks/chatFolders.preload.ts:292` | yes | keeps an open hidden chat from vanishing mid-read |
| `components/leftPane/LeftPaneConversationListItemContextMenu.dom.tsx:371` | **no** | asks "is this chat a member of folder X" for menu actions; membership is the right answer there, visibility is not |

### 5.4 Semantics with overlapping spaces

A conversation in two spaces, where only one has `hideFromAllChats` set, is
still hidden from General. Hiding is a property of the conversation, contributed
by any space that claims it. This is the only coherent rule that does not
require spaces to be mutually exclusive, and mutual exclusivity is explicitly
out of scope.

## 6. Accent theming

### 6.1 Mechanism

Signal's Axo design system defines its accent as CSS custom properties
(`--axo-color-fill-accent` and siblings) in `ts/axo/_tailwind-theme/colors.css`.
Overriding them on `<body>` retints the selected-chat highlight, primary
buttons, links, badges and focus rings with no component changes at all.

The selected space writes **one** variable; a new stylesheet derives the rest
with `color-mix()`, so there is no JS colour maths and no extra stored shades:

```css
/* stylesheets/_truki-spaces.scss (new file) */
body[data-truki-space-accent] {
  --axo-color-fill-accent:           var(--truki-space-accent);
  --axo-color-fill-accent-pressed:   color-mix(in oklab, var(--truki-space-accent) 88%, black);
  --axo-color-fill-accent-bright:    color-mix(in oklab, var(--truki-space-accent) 45%, white);
  --axo-color-fill-accent-tint:      color-mix(in oklab, var(--truki-space-accent) 10%, transparent);
  --axo-color-label-accent:          color-mix(in oklab, var(--truki-space-accent) 85%, black);
}

body[data-truki-space-accent].dark-theme {
  --axo-color-label-accent:          color-mix(in oklab, var(--truki-space-accent) 70%, white);
}
```

A new hook sets `data-truki-space-accent` and `--truki-space-accent` on
`document.body` when the selected space has a colour, and removes both when it
does not. Absent attribute means stock Signal blue, so nothing changes for a
user who never sets a colour.

Light/dark continues to follow the global app setting. Spaces do not carry their
own light/dark mode; switching spaces must never flip the window theme.

### 6.2 Palette

A fixed palette is offered in the picker, stored as `0xAARRGGBB`. Values are
chosen to hold contrast as a button fill in both themes.

| Name | Value |
| --- | --- |
| Blue (default) | `0xff2c6bed` |
| Indigo | `0xff5151f6` |
| Purple | `0xff8d4cc3` |
| Magenta | `0xffc34a9c` |
| Crimson | `0xffcc2d4e` |
| Orange | `0xffd96b1e` |
| Amber | `0xffb8890a` |
| Green | `0xff3a7d44` |
| Teal | `0xff1a7f78` |
| Slate | `0xff5c6b7a` |

Arbitrary custom colours are out of scope.

## 7. Space bar UI

### 7.1 Placement

The space selector moves into the left pane header, replacing the static
"Chats" title.

`NavSidebar` gains **one optional prop**:

```ts
titleSlot?: ReactNode;   // rendered in place of the <h1> when provided
```

Only the Chats tab passes it, so every other `NavSidebar` consumer is
untouched. This is a ~4-line diff in `NavSidebar.dom.tsx` around the existing
`<h1 className="NavSidebar__HeaderTitle">`.

Upstream's strip below the search box stops rendering: the body of
`LeftPaneInboxHelper.getPreRowsNode` returns `null` instead of
`renderLeftPaneChatFolders()`. The render prop and its plumbing stay in place,
unused, to keep that diff to one line.

### 7.2 Appearance

The bar is a **new file**, `ts/components/leftPane/TrukiSpaceBar.dom.tsx`, so
it carries no merge conflict surface.

```
┌────────────────────────────────────────────────┐
│  [🏠 General]  (💼)³  (G)   (🎮)¹²      ⊕  ⋯  │
│   ^selected     ^collapsed: icon + unread      │
│   tinted with   ^no emoji → first letter "G"   │
│   space colour                                 │
└────────────────────────────────────────────────┘
```

- **Selected space** — expanded pill: icon + name, filled with the space's
  accent colour.
- **Unselected space** — collapsed pill: icon only, or the first grapheme of
  the name when no emoji is set, plus its unread badge.
- **Collapsed General with no emoji and no rename** — its `name` is `''`, so the
  grapheme fallback must be taken from the resolved display label (the i18n
  string), never from the empty `name`. A blank pill is a bug.
- The bar scrolls horizontally when it overflows, and keeps upstream's
  `scrollIntoView` focus behaviour.
- Existing per-space context menu actions (mark read, mute, settings) are
  preserved on each pill.

### 7.3 Narrow width

At `WidthBreakpoint.Narrow`, upstream's `AxoSelect` dropdown fallback is kept
as-is. The bar is a wide-layout concern only.

### 7.4 Unread badge on General

General's badge counts only what General shows, so a chat hidden by
`hideFromAllChats` does not contribute to it. This follows automatically from
threading the hidden set into `countUnreadStats`.

## 8. Settings UI

`PreferencesEditChatFoldersPage` gains three controls:

- **Icon** — emoji picker, reusing the Notification Profiles picker.
- **Colour** — swatch picker over the §6.2 palette, reusing the Notification
  Profiles colour picker where its shape allows.
- **Hide these chats from General** — checkbox, bound to `hideFromAllChats`.

`PreferencesChatFoldersPage` makes the General row clickable, opening the same
edit page with the filter sections hidden and only name/icon/colour shown. The
delete action remains absent for General.

## 9. Out of scope

- A space-level mute flag. Upstream's bulk mute is kept exactly as-is.
- Mutually exclusive spaces.
- Per-space light/dark mode.
- Arbitrary custom colours.
- Surface tinting beyond the accent (left pane and nav backgrounds stay neutral).
- Carrying the new fields through local backup export/import. Storage service
  sync repopulates them after a restore, so the loss window is one sync cycle.

## 10. Testing

- **Unit** — `isConversationInChatFolder` with and without a hidden set;
  General's ALL branch with an empty set must equal upstream behaviour.
- **Unit** — the hidden-set selector: empty when no space hides, union across
  several hiding spaces, ignores deleted spaces.
- **Unit** — `ensureTrukiSchema` is idempotent: running twice on a fresh DB and
  on an already-migrated DB both succeed.
- **Round-trip** — `toChatFolderRecord` / `mergeChatFolderRecord` preserve all
  three new fields, and preserve `$unknown` alongside them.
- **Regression** — upstream's existing chat folder tests must pass untouched.
  Any edit to an upstream test is a signal the change was not additive.
- **Storybook** — `TrukiSpaceBar` in selected/unselected, with and without
  emoji, with and without colour, and with a long name.

## 11. File inventory

**New — no upstream conflict surface**

| File | Purpose |
| --- | --- |
| `ts/sql/truki/ensureTrukiSchema.node.ts` | idempotent column installer |
| `ts/components/leftPane/TrukiSpaceBar.dom.tsx` | the space bar |
| `ts/components/leftPane/TrukiSpaceBar.dom.stories.tsx` | Storybook coverage |
| `ts/hooks/useTrukiSpaceAccent.dom.ts` | applies the accent to `<body>` |
| `stylesheets/_truki-spaces.scss` | accent token overrides |
| `ts/types/TrukiSpaceColor.std.ts` | palette + `0xAARRGGBB` helpers |

**Modified — additive only**

| File | Change |
| --- | --- |
| `protos/SignalStorage.proto` | 3 fields at 20001+ |
| `ts/types/ChatFolder.std.ts` | 3 type fields, zod, defaults, 1-line ALL branch, 1 option |
| `ts/sql/server/chatFolders.std.ts` | new columns in read/write queries |
| `ts/sql/migrations/index.node.ts` | import + call `ensureTrukiSchema` |
| `ts/services/storageRecordOps.preload.ts` | map 3 fields both directions |
| `ts/state/ducks/chatFolders.preload.ts` | carry fields through actions; thread hidden set |
| `ts/state/selectors/chatFolders.std.ts` | hidden-set selector |
| `ts/state/selectors/conversations.dom.ts` | thread hidden set |
| `ts/state/ducks/conversations.preload.ts` | thread hidden set |
| `ts/util/countUnreadStats.std.ts` | accept + use hidden set |
| `ts/util/countMutedStats.std.ts` | accept + use hidden set |
| `ts/components/NavSidebar.dom.tsx` | optional `titleSlot` prop |
| `ts/components/LeftPane.dom.tsx` | pass `titleSlot` |
| `ts/components/leftPane/LeftPaneInboxHelper.dom.tsx` | stop rendering the old strip |
| `ts/components/preferences/chatFolders/*` | icon, colour, hide checkbox, editable General |
| `stylesheets/manifest.scss` | import the new stylesheet |
| `_locales/en/messages.json` | new strings |

Roughly 6 new files and 17 additive edits, with no upstream logic deleted or
rewritten.
