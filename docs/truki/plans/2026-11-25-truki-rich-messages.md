# Truki Rich Messages (desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Truki desktop renders agent messages that start with the U+2063 marker as Markdown, draws their `options` block as a card with buttons that send a quote-reply answer, shows answered cards as answered, and shows plain text in chat-list previews and notifications.

**Architecture:** The pure `.std.ts` modules port the hub's wire format and parse Markdown with `mdast-util-from-markdown` + GFM:
- `trukiRichMessage.std.ts`: analyze, resolve answers, format answers, plain text
- `trukiMarkdown.std.ts`: parse Markdown with the Truki rules

New `components/truki` files render the mdast tree and the card. A preload hook computes card props (answered state, send, Other) and spreads them into `TimelineItem`. They reach `Message` through the existing prop spreading, and `Message.renderText` gets one branch.

**Tech Stack:** TypeScript, React, Redux (Signal smart/duck pattern), Axo + `tw()`, `mdast-util-from-markdown` 2.1.0, `micromark-extension-gfm` 3.0.0, `mdast-util-gfm` 3.1.0, `@types/mdast` 4.0.4, electron-mocha + chai, Storybook.

**Spec:** `~/Dokumendid/tehisintellekti-kodu/docs/superpowers/specs/2026-11-16-rich-agent-messages-design.md`. This plan covers build-order step 2: §1 (format), §2 "Answered state" and "Desktop", and §4 desktop. Repo rules: `AGENTS.md`.

## Global Constraints

- **Upstream files edited, and only these**, each as an additive branch or line. Upstream behaviour is unchanged for bodies without the marker.
  - `package.json` (4 devDependencies, exact versions; `saveExact: true`), `pnpm-lock.yaml` (regenerated)
  - `ts/components/conversation/Message.dom.tsx`: one optional `trukiCard` prop in `PropsActions`, one import, one branch in `renderText`
  - `ts/state/smart/TimelineItem.preload.tsx`: one import, one hook call, one `{...trukiCardProps}` spread on `<TimelineItem>`
  - `ts/util/getNotificationDataForMessage.preload.ts`: one import, one branch before `if (body)`
  - `_locales/en/messages.json`: new `icu:TrukiRichMessage--*` / `icu:TrukiOptionsCard--*` keys only
- Never edit an upstream test; no SQL, protobuf or storage changes.
- Truki files have `truki`/`Truki` in their path or name and the header `// Copyright 2026 Truki` / `// SPDX-License-Identifier: AGPL-3.0-only`. Suffixes are derived from imports (fs → `.node.ts`).
- Marker `"⁣"`. Every parser strips it, then parses the remainder (spec §1).
- Options grammar, defaults and answer format exactly as in spec §1. Behaviour is pinned by the shared fixtures, copied from the hub, never edited here.
- Markdown deviations (spec §1):
  - raw HTML renders as literal text
  - an image renders as a link labelled with its alt text, or the URL; nothing is fetched
  - links are active only for `http:`, `https:` and `mailto:`; anything else renders as text
  - nothing is ever rendered via `dangerouslySetInnerHTML`
- Answer bodies:
  - single choice: `✅ <label>`
  - multi-select: `✅ <l1>, <l2>`, in option order
  - with Other text: a newline, then the text
  - Other alone: just the text
- New UI uses Axo + `tw()`, no new SCSS.
- **Verification** (AGENTS.md): quote the literal summary lines.
  - **Linux baseline on this machine** (from the inbox plan; re-measure in Task 1 Step 1):
    - `npx tsc --noEmit`: only `ts/updater/got.main.ts(5,8): error TS6133`
    - `npx oxlint`: only the `got.main.ts` no-unused-vars error
    - test-node: `2456 passing` / `11 pending`
  - **Command forms:**
    - test-node: `env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a pnpm --config.verify-deps-before-run=false run test-node`
    - one file: the same, plus `-- --grep <pattern>` or `-- <file>` per the inbox plan

## Review Focus

1. **Long agent messages (over 2000 bytes).** Signal delivers these as a long-text attachment, and the body is truncated until it is downloaded. Rich rendering must use the same full text `MessageBodyReadMore` gets, and fall back to the upstream path while the attachment is pending. Otherwise a half-received fence parses as an invalid card or broken Markdown. Pinned in Task 4, `renders plain path while long-text attachment is pending`.
2. **A card the user sent themselves** (outgoing direction, e.g. from another device) must show disabled buttons. Pinned in Task 3, `outgoing card is read-only`.
3. **A Markdown link whose text differs from its URL** (`[bank](https://evil)`) must go through the same sneaky-link check as `TrukiFormattedBody` (`isLinkSneaky`). A link to an unsafe scheme renders as text. Pinned in Task 2 (`unsafe schemes become text`) and Task 3 (`sneaky link renders as text`).
4. **Pathological Markdown.** An agent sends a huge table or 10k nested quotes, and the timeline must not lock up. Cap the parsed input at 65 536 characters, like `trukiFormattedBody`, and cap nesting depth at 32 when rendering; anything beyond renders as text. Pinned in Task 2, `caps input length and nesting`.
5. **The answered state must survive the answer arriving from another device.** A synced outgoing quote-reply makes the card answered. A later answer replaces the shown choice. Pinned in Task 4, `findTrukiCardAnswer picks the newest outgoing quote`.

---

### Task 1: Fixtures, dependencies, wire-format module

**Files:**
- Create (hub repo `~/Dokumendid/tehisintellekti-kodu`): `scripts/sync_rich_fixtures.sh`
- Create: `ts/test-node/truki/fixtures/rich-agent-messages/*` (copied by the script)
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `ts/util/trukiRichMessage.std.ts`
- Test: `ts/test-node/truki/trukiRichMessage_test.node.ts`

**Interfaces:**
- Produces, in `trukiRichMessage.std.ts`:
  - `TRUKI_RICH_MARKER = '⁣'`
  - `type TrukiCardOption = Readonly<{ label: string; description: string }>`
  - `type TrukiCard = Readonly<{ question: string; options: ReadonlyArray<TrukiCardOption>; multi: boolean; other: boolean }>`
  - `type TrukiCardAnswer = Readonly<{ selected: ReadonlyArray<string>; other: string | null }>`
  - `isTrukiRich(body: string | undefined | null): boolean`
  - `stripTrukiMarker(body: string): string`
  - `analyzeTrukiRich(body: string): { rich: boolean; card: TrukiCard | null; invalid: boolean }`: exactly the fixture JSON shape
  - `resolveTrukiCardAnswer(card: TrukiCard, body: string, quoted: boolean): TrukiCardAnswer | null`
  - `formatTrukiCardAnswer(card: TrukiCard, selected: ReadonlyArray<string>, other?: string): string`

`analyzeTrukiRich` and `resolveTrukiCardAnswer` are line-for-line ports of `analyze` / `_options_fences` / `parse_options_block` / `resolve_answer` / `_match_labels` in the hub's `scripts/rich_format.py`, with the same rules. `formatTrukiCardAnswer` puts `selected` in option order. With no selection and `other` set, it returns the trimmed `other` text.

- [ ] **Step 1: Baseline.** Run, and record in the ledger, the literal summary lines of `npx tsc --noEmit`, `npx oxlint`, and test-node (Global Constraints form). If they differ from the baseline above, record the new numbers. They are the baseline from now on.
- [ ] **Step 2: Fixture sync script** in the hub: `scripts/sync_rich_fixtures.sh [desktop-dir] [wear-dir]`. Defaults: `~/Dokumendid/truki-desktop`, `~/Dokumendid/truki-wear`. It `rsync -a --delete`s `docs/superpowers/specs/rich-agent-messages-fixtures/` to `<desktop>/ts/test-node/truki/fixtures/rich-agent-messages/`, and skips a destination repo that doesn't exist. (The wear destination is decided in the step 3 plan; for now the script only syncs desktop and has a `# wear: step 3` comment.) Run it, then commit in the hub: `git commit -m "rich messages: fixture sync script"`.
- [ ] **Step 3: Add the dependencies.** Run `pnpm add -D mdast-util-from-markdown@2.1.0 micromark-extension-gfm@3.0.0 mdast-util-gfm@3.1.0 @types/mdast@4.0.4`. Expected: the install succeeds under `minimumReleaseAge` (all are older than 3 days). Then `git diff package.json` shows exactly 4 added devDependency lines.
- [ ] **Step 4: Write the failing tests** in `trukiRichMessage_test.node.ts`:
  - `fixtures`: for every `*.md` in the fixtures dir (read with `fs`), `assert.deepEqual(analyzeTrukiRich(md), json)`.
  - `resolves answers`: the same cases as the hub's `test_rich_format.py` `ResolveTests`, all 12, with `valitud`/`muu` mapped to `selected`/`other`.
  - `formats answers`:
    - single `['B']` → `'✅ B'`
    - multi `['Production','Staging']` → `'✅ Staging, Production'`
    - `(['A'], 'note')` → `'✅ A\nnote'`
    - `([], ' later ')` → `'later'`
  - `isTrukiRich`: true only with the marker as the first character; false for `undefined`.
- [ ] **Step 5: Run and verify it fails.** Run test-node with `-- --grep trukiRichMessage`. Expected: it fails, because the module cannot be resolved.
- [ ] **Step 6: Implement `ts/util/trukiRichMessage.std.ts`** to the Interfaces above.
- [ ] **Step 7: Run and verify it passes.** Run the same command. Expected: all `trukiRichMessage` tests pass.
- [ ] **Step 8: Commit.** `git add package.json pnpm-lock.yaml ts/util/trukiRichMessage.std.ts ts/test-node/truki/trukiRichMessage_test.node.ts ts/test-node/truki/fixtures/rich-agent-messages && git commit -m "truki(rich): wire format, shared fixtures, markdown deps"`

### Task 2: Markdown parsing and plain text

**Files:**
- Create: `ts/util/trukiMarkdown.std.ts`
- Test: `ts/test-node/truki/trukiMarkdown_test.std.ts`

**Interfaces:**
- Consumes: `stripTrukiMarker`, `analyzeTrukiRich` (Task 1).
- Produces:
  - `parseTrukiMarkdown(body: string): { root: Root; card: TrukiCard | null }`. `body` is the full message body, marker included. `Root` is `mdast`'s type. Steps:
    1. strip the marker
    2. truncate to 65 536 chars
    3. `fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })`
    4. transform the tree:
       - `html` → `text` (same value)
       - `image` → `link` with one `text` child (alt or URL)
       - a `link` whose URL fails `/^(https?:|mailto:)/i` → its children inlined
       - if `analyzeTrukiRich(body).card` is set, remove the single top-level `code` node with `lang === 'options'` and no `meta`
  - `getTrukiRichPlainText(body: string): string`:
    - with a card: the question
    - otherwise: the text content of the tree, with block nodes joined by `\n` and whitespace collapsed within lines
    - capped at 500 chars

- [ ] **Step 1: Write the failing tests:**
  - `renders raw html as text`: `<b>x</b>` gives a `text` node whose value includes `<b>`.
  - `images become links`: `![logo](https://a/b.png)` gives a `link` with URL `https://a/b.png` and text `logo`. With empty alt, the text is the URL.
  - `unsafe schemes become text`: `[x](javascript:alert(1))` has no `link` node, and `x` is present as text. `[m](mailto:a@b)` stays a link.
  - `removes the options block only for a valid card`: a fixture-04 body → no `code` node with lang `options`, and `card.question` is set. Fixture 09 (invalid) → the `code` node is kept and `card` is null.
  - `parses gfm`: a table, a task list, strikethrough and a footnote each produce their mdast node types (`table`, `listItem.checked`, `delete`, `footnoteReference`).
  - `caps input length and nesting`: a 200 000-char body parses in under 2 s, and the root's source length is ≤ 65 536.
  - `plain text`:
    - a card body → the question
    - `# T\n\n**b** text` → `'T\nb text'`
    - no marker → `body` unchanged
- [ ] **Step 2: Run and verify it fails.** `--grep trukiMarkdown`. Expected: the module cannot be resolved.
- [ ] **Step 3: Implement `ts/util/trukiMarkdown.std.ts`.**
- [ ] **Step 4: Run and verify it passes.** Expected: all pass. Also run `npx tsc --noEmit` and `npx oxlint`. Expected: the baseline lines only.
- [ ] **Step 5: Commit.** `git commit -m "truki(rich): markdown parsing and plain text"`

### Task 3: Rendering components

**Files:**
- Create: `ts/components/truki/TrukiRichBody.dom.tsx`, `ts/components/truki/TrukiOptionsCard.dom.tsx`, `ts/components/truki/TrukiRichBody.dom.stories.tsx`
- Modify: `_locales/en/messages.json`. Add after `icu:TrukiFormattedBody--ShowMore`:
  - `icu:TrukiOptionsCard--Send` "Send"
  - `icu:TrukiOptionsCard--Other` "Other…"
  - `icu:TrukiOptionsCard--Answered` "Answered"
  - `icu:TrukiOptionsCard--OtherAnswer` "Other: {text}"
  - `icu:TrukiOptionsCard--ChooseAny` "Choose any"
  - `icu:TrukiOptionsCard--ChooseOne` "Choose one"

  Each has a `description`, following the neighbouring keys.
- Test: `ts/test-node/truki/trukiRichBody_test.preload.tsx` (`renderToStaticMarkup` inside `AxoProvider`, as in `trukiConnectedAccounts_test.preload.tsx`)

**Interfaces:**
- Consumes: `parseTrukiMarkdown` (Task 2); `TrukiCard`, `TrukiCardAnswer`, `formatTrukiCardAnswer` (Task 1).
- Produces:
  - `type TrukiCardMessageProps = Readonly<{ answer: TrukiCardAnswer | null; sendAnswer: (body: string) => void; startOtherAnswer: () => void }>`. Exported from `TrukiRichBody.dom.tsx`; `Message` and the hook import it.
  - `TrukiRichBody(props: { i18n: LocalizerType; text: string; direction: 'incoming' | 'outgoing'; trukiCard?: TrukiCardMessageProps }): JSX.Element`. It renders the mdast tree, then `TrukiOptionsCard` if `card` is set.
  - `TrukiOptionsCard(props: { i18n; card: TrukiCard; answer: TrukiCardAnswer | null; disabled: boolean; onAnswer: (body: string) => void; onOther: () => void }): JSX.Element`.

Rendering rules for `TrukiRichBody`:
- Headings → `h1`–`h3`-styled `div`s via `tw()`; `h4`–`h6` render like `h3`.
- Lists use `ul`/`ol`; task items get a disabled checkbox glyph.
- Tables go inside a horizontally scrolling `div`.
- `code` → `pre > code`; `inlineCode` → `code`.
- `blockquote`, `thematicBreak` → `hr`, `break` → `br`.
- Footnote definitions are collected and rendered as a numbered list at the end.
- `linkReference` / `imageReference` are resolved through `definition` nodes; an unresolved one renders as its source text.
- Links follow `TrukiFormattedBody`'s link rendering: `isLinkSneaky` → text.
- Depth beyond 32 → `toString` of the subtree as text.

`TrukiOptionsCard`:
- **disabled** is `direction === 'outgoing' || !trukiCard`.
- **single choice:** one `AxoButton` per option (label; description as secondary text). A click calls `onAnswer(formatTrukiCardAnswer(card, [label]))`.
- **multi-select:** an `AxoCheckbox` per option, plus a **Send** button that is disabled until one is checked. Send calls `onAnswer(formatTrukiCardAnswer(card, checked))`.
- **Other…** button, when `card.other` is set: calls `onOther()`.
- **answered** (`answer != null`): all controls are disabled, the selected options are highlighted (`aria-pressed`/checked), an "Answered" line is shown, and the other text appears as `OtherAnswer`.

- [ ] **Step 1: Write the failing tests:**
  - `renders markdown`: a table body gives `<table`; a heading gives its text; raw `<script>` appears escaped in the markup (`&lt;script&gt;`).
  - `renders the card`: a fixture-05 body with `trukiCard` (answer null) gives 2 enabled buttons with labels and descriptions, plus an `Other…` button.
  - `multi card has checkboxes and a disabled send`.
  - `answered card is disabled and highlights the choice`: with `answer: { selected: ['Staging'], other: null }`, every button is `disabled`, `Staging` has `aria-pressed="true"`, and `Answered` is present.
  - `outgoing card is read-only`: direction `outgoing` → all buttons disabled.
  - `sneaky link renders as text`: a link whose visible text is a different domain than its URL has no `<a` for it.
  - `invalid card renders as code`: a fixture-09 body gives a `<pre` containing `? Pick`, and no buttons.
- [ ] **Step 2: Run and verify it fails.** `--grep trukiRichBody`. Expected: the modules cannot be resolved.
- [ ] **Step 3: Implement** both components and the locale keys.
- [ ] **Step 4: Run and verify it passes.** Expected: pass. `npx tsc --noEmit` and `npx oxlint`: the baseline lines only.
- [ ] **Step 5: Stories.** `TrukiRichBody.dom.stories.tsx`, with one story each for: Markdown report (headings, table, code, footnote), Single, Multi, Other only (`other: yes`, 2 options), Answered, Outgoing, Invalid block, Long code line. Start Storybook (`pnpm run dev`, then poll `curl -sf http://127.0.0.1:6006/`), open each story, and confirm it renders without console errors. Then stop Storybook.
- [ ] **Step 6: Commit.** `git commit -m "truki(rich): rich body and options card components"`

### Task 4: Wiring into the timeline, sending, previews

**Files:**
- Create: `ts/state/smart/trukiCardProps.preload.ts`, `ts/util/trukiSendCardAnswer.preload.ts`, and the pure helper in `ts/util/trukiRichMessage.std.ts` (extend it)
- Modify:
  - `ts/components/conversation/Message.dom.tsx`: optional prop `trukiCard?: TrukiCardMessageProps` in `PropsActions`, and a branch in `renderText`
  - `ts/state/smart/TimelineItem.preload.tsx`
  - `ts/util/getNotificationDataForMessage.preload.ts`
- Test: `ts/test-node/truki/trukiCardProps_test.std.ts`, and extend `trukiRichBody_test.preload.tsx`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - In `trukiRichMessage.std.ts`: `findTrukiCardAnswer(messages: Iterable<Readonly<{ type?: string; sent_at?: number; body?: string; quote?: { id?: number | null } | null }>>, card: TrukiCard, cardSentAt: number): TrukiCardAnswer | null`. It takes the outgoing message with the largest `sent_at` whose `quote.id === cardSentAt` and whose body resolves (`quoted = true`).
  - `sendTrukiCardAnswer(conversationId: string, cardMessageId: string, body: string): Promise<void>` in `trukiSendCardAnswer.preload.ts`:
    1. get the conversation and the message (`getMessageById`)
    2. `quote = await makeQuote(message.attributes)`, then override `quote.text` with `getTrukiRichPlainText(body of the card)` and `bodyRanges: []`, so quotes read cleanly in official clients
    3. `conversation.enqueueMessageForSend({ body, attachments: [], quote, preview: [], bodyRanges: [] }, {})`

    Errors are logged with `log.error('sendTrukiCardAnswer: …')`, following upstream `log` usage.
  - `useTrukiCardProps(item: TimelineItemType | undefined): { trukiCard?: TrukiCardMessageProps }` in `trukiCardProps.preload.ts`. It returns `{}` unless the item is a message whose `data.text` is rich with a valid card. Otherwise:
    - `answer`: `useSelector` over `state.conversations.messagesByConversation[conversationId].messageIds` → `messagesLookup` → `findTrukiCardAnswer`
    - `sendAnswer`: calls `sendTrukiCardAnswer(conversationId, id, body)` via `drop()`
    - `startOtherAnswer`: `setQuoteByMessageId(conversationId, id)` from `useComposerActions()`

Upstream edits:
- **`Message.renderText`:** where it renders `<MessageBodyReadMore …/>`, render `<TrukiRichBody i18n text direction trukiCard={this.props.trukiCard} />` instead when `isTrukiRich(text) && (!textAttachment || isDownloaded(textAttachment))`. `text` is the same `text` prop `MessageBodyReadMore` gets.
- **Smart `TimelineItem`:** `const trukiCardProps = useTrukiCardProps(item);` next to the other hooks, and `{...trukiCardProps}` as the last attribute before the closing `/>` of `<TimelineItem`.
- **`getNotificationDataForMessage`:** immediately before `if (body) {`, add `if (body && isTrukiRich(body)) { return { text: getTrukiRichPlainText(body) }; }`.

- [ ] **Step 1: Write the failing tests:**
  - **`trukiCardProps_test.std.ts`:**
    - `findTrukiCardAnswer picks the newest outgoing quote`: two outgoing quote-replies to `sent_at` 100, `✅ A` then `✅ B` → selected `['B']`.
    - An incoming message quoting it is ignored.
    - A quote to 101 is ignored.
    - An unresolvable body (`✅ Nope`) is skipped in favour of an older valid one.
    - None at all → null.
  - **`trukiRichBody_test.preload.tsx`**, `Message` integration: render `Message` (minimal props, reusing the props helper from upstream's `Message.dom.stories.tsx`, imported, not edited):
    - a marker body → contains `<table` (Markdown path)
    - a plain body → no Truki markup
    - `renders plain path while long-text attachment is pending`: rich text plus a `textAttachment` with `pending: true` → no Truki markup
  - **Notification text:** `getNotificationDataForMessage` on attributes with a card body → `text` equals the question. Put this in `trukiCardProps_test.std.ts` only if the import graph allows. Otherwise use a new `trukiNotificationText_test.preload.ts` with the same assertion.
- [ ] **Step 2: Run and verify it fails.** `--grep "trukiCardProps|trukiRichBody|trukiNotification"`. Expected: `findTrukiCardAnswer` is not exported, and the Markdown-path assertions fail.
- [ ] **Step 3: Implement** the helper, the hook, the send function, and the three upstream edits.
- [ ] **Step 4: Run and verify it passes.** The same grep → pass.
- [ ] **Step 5: Upstream diff check.** Run `git diff --stat main -- ':!ts/**/truki*' ':!ts/**/Truki*' ':!ts/**/truki/**' ':!docs'`. Expected: only `package.json`, `pnpm-lock.yaml`, `Message.dom.tsx`, `TimelineItem.preload.tsx`, `getNotificationDataForMessage.preload.ts` and `_locales/en/messages.json`. In `git diff main -- <each>`, every hunk is additions only (no `-` lines except the lockfile).
- [ ] **Step 6: Commit.** `git commit -m "truki(rich): timeline wiring, card answers, plain previews"`

### Task 5: Full verification and live check

**Files:** none new (fixes only, if a check fails).

- [ ] **Step 1: Type check and lint.** Run `npx tsc --noEmit` and `npx oxlint`. Expected: exactly the Task 1 baseline lines. Quote both summary lines.
- [ ] **Step 2: test-node** (Global Constraints form). Expected: baseline passing + the new tests, the same pending count, 0 failing. Quote the summary line.
- [ ] **Step 3: test-electron.** Run `env -u ELECTRON_RUN_AS_NODE xvfb-run -a pnpm --config.verify-deps-before-run=false run test-electron`. Expected: no failures beyond those in a baseline run on `main`. Run that baseline first if none is recorded. Quote both summary lines.
- [ ] **Step 4: Live check with the user.**
  1. Start the dev app (the repo's usual dev start, per the `run` skill).
  2. From the hub, send a card: `python3 -c "…tool_signal_ask({'kusimus': 'Truki desktop test', 'valikud': [{'silt': 'Esimene'}, {'silt': 'Teine', 'kirjeldus': 'vali see'}], 'sonum': '## Live\n\n| a | b |\n|---|---|\n| 1 | 2 |'})"`.
  3. Confirm: the heading and table render; two buttons appear; the chat-list preview shows `Truki desktop test`; clicking **Teine** sends `✅ Teine` as a quote-reply; the card turns answered; the hub registry shows `valitud: ['Teine']`.
- [ ] **Step 5: Commit fixes, if any.** Then push the branch per the user's go-ahead.
