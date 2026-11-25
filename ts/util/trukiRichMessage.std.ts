// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Rich agent messages: wire format (marker, options block, answers).
// Port of the hub's scripts/rich_format.py; behaviour is pinned by the
// shared fixtures in ts/test-node/truki/fixtures/rich-agent-messages/.
// Spec: tehisintellekti-kodu docs/superpowers/specs/
//   2026-11-16-rich-agent-messages-design.md

export const TRUKI_RICH_MARKER = '⁣';

export type TrukiCardOption = Readonly<{ label: string; description: string }>;

export type TrukiCard = Readonly<{
  question: string;
  options: ReadonlyArray<TrukiCardOption>;
  multi: boolean;
  other: boolean;
}>;

export type TrukiCardAnswer = Readonly<{
  selected: ReadonlyArray<string>;
  other: string | null;
}>;

export type TrukiRichAnalysis = {
  rich: boolean;
  card: TrukiCard | null;
  invalid: boolean;
};

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_LABEL = 80;
const CHECK = '✅';

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const OPTION_SPLIT = /^(.*?)\s+(?:—|--)\s+(.*)$/;
const KEY_LINE = /^(multi|other)\s*:\s*(.*)$/i;
const NUMBERS = /^\d+(\s*,\s*\d+)*$/;

class TrukiCardError extends Error {}

export function isTrukiRich(body: string | undefined | null): boolean {
  return body != null && body.startsWith(TRUKI_RICH_MARKER);
}

export function stripTrukiMarker(body: string): string {
  return isTrukiRich(body) ? body.slice(TRUKI_RICH_MARKER.length) : body;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Top-level options fences: [content lines, closed]. CommonMark rules: a
// fence closes with the same character, at least as long, no info string;
// an unclosed fence swallows the rest of the text.
function findOptionsFences(
  text: string
): Array<{ lines: Array<string>; closed: boolean }> {
  const lines = text.split('\n');
  const found: Array<{ lines: Array<string>; closed: boolean }> = [];
  let i = 0;
  while (i < lines.length) {
    const match = FENCE_OPEN.exec(lines[i] ?? '');
    if (!match) {
      i += 1;
      continue;
    }
    const fence = match[1] ?? '';
    const info = (match[2] ?? '').trim();
    const close = new RegExp(
      `^ {0,3}${escapeRegExp(fence[0] ?? '')}{${fence.length},}\\s*$`
    );
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j] ?? '')) {
      j += 1;
    }
    if (info === 'options') {
      found.push({ lines: lines.slice(i + 1, j), closed: j < lines.length });
    }
    i = j + 1;
  }
  return found;
}

function parseOptionsBlock(lines: ReadonlyArray<string>): TrukiCard {
  let question: string | undefined;
  const options: Array<TrukiCardOption> = [];
  const keys = new Map<string, boolean>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith('?')) {
      if (question !== undefined) {
        throw new TrukiCardError('question repeated');
      }
      question = line.slice(1).trim();
      if (!question) {
        throw new TrukiCardError('empty question');
      }
    } else if (line === '-' || line.startsWith('- ')) {
      const text = line.slice(1);
      const split = OPTION_SPLIT.exec(text);
      const label = (split ? (split[1] ?? '') : text).trim();
      const description = split ? (split[2] ?? '').trim() : '';
      if (!label) {
        throw new TrukiCardError('empty label');
      }
      if (label.length > MAX_LABEL) {
        throw new TrukiCardError('label too long');
      }
      if (options.some(o => o.label.toLowerCase() === label.toLowerCase())) {
        throw new TrukiCardError('duplicate label');
      }
      options.push({ label, description });
    } else {
      const match = KEY_LINE.exec(line);
      if (!match) {
        throw new TrukiCardError('unknown line');
      }
      const key = (match[1] ?? '').toLowerCase();
      const value = (match[2] ?? '').trim().toLowerCase();
      if (keys.has(key)) {
        throw new TrukiCardError('duplicate key');
      }
      if (value !== 'yes' && value !== 'no') {
        throw new TrukiCardError('bad key value');
      }
      keys.set(key, value === 'yes');
    }
  }
  if (question === undefined) {
    throw new TrukiCardError('missing question');
  }
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new TrukiCardError('option count');
  }
  return {
    question,
    options,
    multi: keys.get('multi') ?? false,
    other: keys.get('other') ?? true,
  };
}

export function analyzeTrukiRich(body: string): TrukiRichAnalysis {
  if (!isTrukiRich(body)) {
    return { rich: false, card: null, invalid: false };
  }
  // The marker is not Markdown whitespace: always parse the text after it.
  const fences = findOptionsFences(stripTrukiMarker(body));
  const [first] = fences;
  if (!first) {
    return { rich: true, card: null, invalid: false };
  }
  if (fences.length > 1 || !first.closed) {
    return { rich: true, card: null, invalid: true };
  }
  try {
    return { rich: true, card: parseOptionsBlock(first.lines), invalid: false };
  } catch (error) {
    if (error instanceof TrukiCardError) {
      return { rich: true, card: null, invalid: true };
    }
    throw error;
  }
}

// "A, B" -> {A, B}: known labels, longest first (a label may contain a comma).
function matchLabels(
  first: string,
  labels: ReadonlyArray<string>
): Set<string> | null {
  const chosen = new Set<string>();
  let rest = first.trim();
  const byLength = [...labels].sort((a, b) => b.length - a.length);
  while (rest) {
    let matched = false;
    for (const label of byLength) {
      if (!rest.toLowerCase().startsWith(label.toLowerCase())) {
        continue;
      }
      const after = rest.slice(label.length);
      if (after.trim() === '') {
        chosen.add(label);
        rest = '';
        matched = true;
        break;
      }
      if (after.trimStart().startsWith(',')) {
        chosen.add(label);
        rest = after.trimStart().slice(1).trimStart();
        matched = true;
        break;
      }
    }
    if (!matched) {
      return null;
    }
  }
  return chosen;
}

export function resolveTrukiCardAnswer(
  card: TrukiCard,
  body: string,
  quoted: boolean
): TrukiCardAnswer | null {
  const labels = card.options.map(o => o.label);
  const text = body.trim();
  if (NUMBERS.test(text)) {
    const indexes = [...new Set(text.split(',').map(x => Number(x.trim())))];
    if (indexes.some(i => i < 1 || i > labels.length)) {
      return null;
    }
    if (!card.multi && indexes.length > 1) {
      return null;
    }
    return {
      selected: indexes.sort((a, b) => a - b).map(i => labels[i - 1] ?? ''),
      other: null,
    };
  }
  if (text.startsWith(CHECK)) {
    const rest = text.slice(CHECK.length);
    const newline = rest.indexOf('\n');
    const first = newline === -1 ? rest : rest.slice(0, newline);
    const other =
      newline === -1 ? null : rest.slice(newline + 1).trim() || null;
    const chosen = matchLabels(first, labels);
    if (chosen == null) {
      return null;
    }
    if (other && !card.other) {
      return null;
    }
    if (!card.multi && chosen.size > 1) {
      return null;
    }
    if (chosen.size === 0 && !other) {
      return null;
    }
    return { selected: labels.filter(l => chosen.has(l)), other };
  }
  if (quoted && card.other && text) {
    return { selected: [], other: text };
  }
  return null;
}

export function formatTrukiCardAnswer(
  card: TrukiCard,
  selected: ReadonlyArray<string>,
  other?: string
): string {
  const chosen = new Set(selected);
  const labels = card.options.map(o => o.label).filter(l => chosen.has(l));
  const otherText = other?.trim() ?? '';
  if (labels.length === 0) {
    return otherText;
  }
  const head = `${CHECK} ${labels.join(', ')}`;
  return otherText ? `${head}\n${otherText}` : head;
}

export type TrukiQuotingMessage = Readonly<{
  type?: string;
  sent_at?: number;
  body?: string;
  quote?: Readonly<{ id?: number | null }> | null;
}>;

// The card's answer: the newest outgoing quote-reply to it whose body
// resolves. Answers are ordinary synced messages, so one sent from any of
// the user's devices counts.
export function findTrukiCardAnswer(
  messages: Iterable<TrukiQuotingMessage>,
  card: TrukiCard,
  cardSentAt: number
): TrukiCardAnswer | null {
  const replies = [...messages]
    .filter(
      m => m.type === 'outgoing' && m.quote?.id === cardSentAt && m.body != null
    )
    .sort((a, b) => (b.sent_at ?? 0) - (a.sent_at ?? 0));
  for (const reply of replies) {
    const answer = resolveTrukiCardAnswer(card, reply.body ?? '', true);
    if (answer) {
      return answer;
    }
  }
  return null;
}

// Markdown parsing (micromark) is superlinear on some inputs: runs of
// emphasis markers and deep container nesting. Anything a sender could use
// to stall the renderer falls back to plain text. Limits measured: worst
// case at these bounds parses in well under a second.
const MAX_RICH_LENGTH = 8000;
const MAX_EMPHASIS_MARKERS = 600;
const MAX_NESTING = 16;
const CONTAINER_PREFIX =
  /^[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))[ \t]?/;

function lineNestingExceeds(line: string): boolean {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
  let depth = Math.floor(indent.replace(/\t/g, '    ').length / 2);
  let rest = line;
  while (depth <= MAX_NESTING) {
    const match = CONTAINER_PREFIX.exec(rest);
    if (!match || match[0].length === 0) {
      break;
    }
    depth += 1;
    rest = rest.slice(match[0].length);
  }
  return depth > MAX_NESTING;
}

// `text` is the body without the marker.
export function isTrukiMarkdownSafe(text: string): boolean {
  if (text.length > MAX_RICH_LENGTH) {
    return false;
  }
  let markers = 0;
  for (const ch of text) {
    if (ch === '*' || ch === '_' || ch === '~') {
      markers += 1;
      if (markers > MAX_EMPHASIS_MARKERS) {
        return false;
      }
    }
  }
  return !text.split('\n').some(lineNestingExceeds);
}

// Message.renderText: render rich only once the full text is here (a long
// message's tail arrives as a long-text attachment) and only when parsing
// it is safe.
export function shouldRenderTrukiRich(
  text: string | undefined | null,
  longTextPending: boolean
): boolean {
  return (
    text != null &&
    isTrukiRich(text) &&
    !longTextPending &&
    isTrukiMarkdownSafe(stripTrukiMarker(text))
  );
}

// The card whose buttons may act: only where upstream would allow a reply
// (not in message requests, blocked chats or terminated groups).
export function getTrukiCardForMessage(
  message: Readonly<{ text?: string | null; canReply?: boolean }>
): TrukiCard | null {
  const { text, canReply } = message;
  if (!canReply || text == null || !shouldRenderTrukiRich(text, false)) {
    return null;
  }
  return analyzeTrukiRich(text).card;
}
