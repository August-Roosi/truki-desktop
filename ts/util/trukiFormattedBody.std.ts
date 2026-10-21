// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { missingCaseError } from './missingCaseError.std.ts';

export type TrukiBodyNode =
  | { kind: 'text'; text: string }
  | {
      kind: 'b' | 'i' | 's' | 'code' | 'pre';
      children: ReadonlyArray<TrukiBodyNode>;
    }
  | { kind: 'br' }
  | { kind: 'link'; href: string; children: ReadonlyArray<TrukiBodyNode> };

const MAX_NESTING_DEPTH = 32;

const SAFE_HREF_PATTERN = /^(https?:|mailto:)/i;
const HREF_JUNK_PATTERN = /[\p{Zs}\p{C}]/gu;

type ContainerKind = 'b' | 'i' | 's' | 'code' | 'pre' | 'link';

function normalizeTagName(name: string): ContainerKind | 'br' | undefined {
  switch (name.toLowerCase()) {
    case 'b':
    case 'strong':
      return 'b';
    case 'i':
    case 'em':
      return 'i';
    case 's':
    case 'del':
    case 'strike':
      return 's';
    case 'code':
      return 'code';
    case 'pre':
      return 'pre';
    case 'a':
      return 'link';
    case 'br':
      return 'br';
    default:
      return undefined;
  }
}

function isTagNameStart(ch: string): boolean {
  return /[a-zA-Z]/.test(ch);
}

function isTagNameChar(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch);
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * Tries to decode the HTML entity starting at `index` (which must point at `&`).
 * Recognises `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&#NNN;`, `&#xHH;`.
 */
function matchEntity(
  input: string,
  index: number
): { value: string; next: number } | undefined {
  const semicolon = input.indexOf(';', index + 1);
  if (semicolon === -1 || semicolon - index > 12) {
    return undefined;
  }
  const name = input.slice(index + 1, semicolon);
  const lower = name.toLowerCase();
  if (lower === 'amp') {
    return { value: '&', next: semicolon + 1 };
  }
  if (lower === 'lt') {
    return { value: '<', next: semicolon + 1 };
  }
  if (lower === 'gt') {
    return { value: '>', next: semicolon + 1 };
  }
  if (lower === 'quot') {
    return { value: '"', next: semicolon + 1 };
  }
  let code: number | undefined;
  if (/^#\d{1,10}$/.test(lower)) {
    code = Number(lower.slice(1));
  } else if (/^#x[0-9a-f]{1,8}$/.test(lower)) {
    code = parseInt(lower.slice(2), 16);
  }
  if (code === undefined || code < 0 || code > 0x10ffff) {
    return undefined;
  }
  try {
    return { value: String.fromCodePoint(code), next: semicolon + 1 };
  } catch {
    return undefined;
  }
}

/** Decodes every entity in a string, used for attribute values. */
function decodeEntities(value: string): string {
  let result = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] === '&') {
      const entity = matchEntity(value, i);
      if (entity) {
        result += entity.value;
        i = entity.next;
        continue;
      }
    }
    result += value[i];
    i += 1;
  }
  return result;
}

type OpenTag = Readonly<{
  name: string;
  /** Index just past the closing `>`. */
  end: number;
  selfClosing: boolean;
  href: string | undefined;
}>;

/**
 * Parses the tag starting at `index` (which must point at `<` and be followed
 * by a letter). Only the `href` attribute of `a` tags is captured; every other
 * attribute is consumed and dropped. Returns undefined for malformed markup
 * (no closing `>` before the end of the input).
 */
function parseOpenTag(input: string, index: number): OpenTag | undefined {
  const len = input.length;
  let pos = index + 1;
  let name = '';
  while (pos < len && isTagNameChar(input.charAt(pos))) {
    name += input.charAt(pos);
    pos += 1;
  }
  if (name === '') {
    return undefined;
  }
  let href: string | undefined;
  while (pos < len) {
    while (pos < len && isWhitespace(input.charAt(pos))) {
      pos += 1;
    }
    if (pos >= len) {
      return undefined;
    }
    if (input.charAt(pos) === '>') {
      return { name, end: pos + 1, selfClosing: false, href };
    }
    if (input.charAt(pos) === '/') {
      if (pos + 1 < len && input.charAt(pos + 1) === '>') {
        return { name, end: pos + 2, selfClosing: true, href };
      }
      pos += 1;
      continue;
    }
    // Attribute name.
    let attrName = '';
    while (
      pos < len &&
      !isWhitespace(input.charAt(pos)) &&
      input.charAt(pos) !== '=' &&
      input.charAt(pos) !== '>' &&
      input.charAt(pos) !== '/'
    ) {
      attrName += input.charAt(pos);
      pos += 1;
    }
    let attrValue: string | undefined;
    while (pos < len && isWhitespace(input.charAt(pos))) {
      pos += 1;
    }
    if (pos < len && input.charAt(pos) === '=') {
      pos += 1;
      while (pos < len && isWhitespace(input.charAt(pos))) {
        pos += 1;
      }
      if (pos >= len) {
        return undefined;
      }
      const quote = input.charAt(pos);
      if (quote === '"' || quote === "'") {
        const closing = input.indexOf(quote, pos + 1);
        if (closing === -1) {
          return undefined;
        }
        attrValue = input.slice(pos + 1, closing);
        pos = closing + 1;
      } else {
        let value = '';
        while (
          pos < len &&
          !isWhitespace(input.charAt(pos)) &&
          input.charAt(pos) !== '>'
        ) {
          value += input.charAt(pos);
          pos += 1;
        }
        // Keep a trailing `/` available so `href=x/>` self-closes.
        if (value.endsWith('/') && pos < len && input.charAt(pos) === '>') {
          value = value.slice(0, -1);
          pos -= 1;
        }
        attrValue = value;
      }
    }
    if (attrName === '' && attrValue === undefined) {
      // Junk character; skip it so we can never loop forever.
      pos += 1;
    } else if (attrName.toLowerCase() === 'href' && href === undefined) {
      href = attrValue ?? '';
    }
  }
  return undefined;
}

/** Decodes and cleans an href; returns undefined when it is not a safe scheme. */
function cleanHref(rawHref: string | undefined): string | undefined {
  if (rawHref === undefined) {
    return undefined;
  }
  const cleaned = decodeEntities(rawHref)
    .trim()
    .replace(HREF_JUNK_PATTERN, '');
  if (!SAFE_HREF_PATTERN.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

type FrameType = {
  kind: ContainerKind;
  href?: string;
  /** Set for `a` tags without a safe href: children are spliced into the parent. */
  unwrap: boolean;
  children: Array<TrukiBodyNode>;
};

export function parseTrukiFormattedBody(
  formattedBody: string
): ReadonlyArray<TrukiBodyNode> {
  const root: Array<TrukiBodyNode> = [];
  const stack: Array<FrameType> = [];
  let textBuffer = '';

  const target = (): Array<TrukiBodyNode> => {
    const frame = stack.at(-1);
    return frame !== undefined ? frame.children : root;
  };

  const flushText = (): void => {
    if (textBuffer !== '') {
      target().push({ kind: 'text', text: textBuffer });
      textBuffer = '';
    }
  };

  const closeTop = (): void => {
    const frame = stack.pop();
    if (!frame) {
      return;
    }
    const parent = target();
    if (frame.unwrap) {
      parent.push(...frame.children);
      return;
    }
    if (frame.kind === 'link') {
      parent.push({
        kind: 'link',
        href: frame.href ?? '',
        children: frame.children,
      });
      return;
    }
    parent.push({ kind: frame.kind, children: frame.children });
  };

  const closeKind = (kind: ContainerKind): void => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const frame = stack.at(i);
      if (frame !== undefined && frame.kind === kind) {
        while (stack.length > i) {
          closeTop();
        }
        return;
      }
    }
    // No matching open tag: drop the close tag.
  };

  const openContainer = (kind: ContainerKind, href?: string): void => {
    if (stack.length >= MAX_NESTING_DEPTH) {
      // Deeper than the cap: drop the tag, its content flows at this level.
      return;
    }
    const cleanedHref = kind === 'link' ? cleanHref(href) : undefined;
    stack.push({
      kind,
      href: cleanedHref,
      unwrap: kind === 'link' && cleanedHref === undefined,
      children: [],
    });
  };

  const len = formattedBody.length;
  let pos = 0;
  while (pos < len) {
    const ch = formattedBody.charAt(pos);
    if (ch === '<') {
      if (formattedBody.startsWith('<!--', pos)) {
        flushText();
        const end = formattedBody.indexOf('-->', pos + 4);
        pos = end === -1 ? len : end + 3;
        continue;
      }
      if (formattedBody.startsWith('<!', pos)) {
        flushText();
        const end = formattedBody.indexOf('>', pos + 1);
        pos = end === -1 ? len : end + 1;
        continue;
      }
      if (formattedBody.startsWith('</', pos)) {
        let p = pos + 2;
        let name = '';
        while (p < len && isTagNameChar(formattedBody.charAt(p))) {
          name += formattedBody.charAt(p);
          p += 1;
        }
        while (p < len && isWhitespace(formattedBody.charAt(p))) {
          p += 1;
        }
        if (name !== '' && p < len && formattedBody.charAt(p) === '>') {
          flushText();
          const kind = normalizeTagName(name);
          if (kind !== undefined && kind !== 'br') {
            closeKind(kind);
          }
          pos = p + 1;
          continue;
        }
        // Malformed close tag: treat as text.
        textBuffer += '<';
        pos += 1;
        continue;
      }
      if (pos + 1 < len && isTagNameStart(formattedBody.charAt(pos + 1))) {
        const tag = parseOpenTag(formattedBody, pos);
        if (!tag) {
          // Malformed open tag: treat as text.
          textBuffer += '<';
          pos += 1;
          continue;
        }
        const lowerName = tag.name.toLowerCase();
        if (lowerName === 'script' || lowerName === 'style') {
          flushText();
          const closePattern = new RegExp(`</${lowerName}`, 'i');
          closePattern.lastIndex = 0;
          const rest = formattedBody.slice(tag.end);
          const match = closePattern.exec(rest);
          if (match) {
            const closeEnd = formattedBody.indexOf('>', tag.end + match.index);
            pos = closeEnd === -1 ? len : closeEnd + 1;
          } else {
            pos = len;
          }
          continue;
        }
        const kind = normalizeTagName(tag.name);
        if (kind === undefined) {
          // Unknown tag: drop it, its content flows at this level.
          pos = tag.end;
          continue;
        }
        flushText();
        if (kind === 'br') {
          target().push({ kind: 'br' });
          pos = tag.end;
          continue;
        }
        if (tag.selfClosing) {
          // Self-closed container: nothing to show.
          pos = tag.end;
          continue;
        }
        openContainer(kind, tag.href);
        pos = tag.end;
        continue;
      }
      textBuffer += '<';
      pos += 1;
      continue;
    }
    if (ch === '&') {
      const entity = matchEntity(formattedBody, pos);
      if (entity) {
        textBuffer += entity.value;
        pos = entity.next;
        continue;
      }
    }
    textBuffer += ch;
    pos += 1;
  }
  flushText();
  while (stack.length > 0) {
    closeTop();
  }
  return root;
}

function countTextLength(nodes: ReadonlyArray<TrukiBodyNode>): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === 'text') {
      total += node.text.length;
    } else if (node.kind !== 'br') {
      total += countTextLength(node.children);
    }
  }
  return total;
}

export function truncateTrukiBody(
  nodes: ReadonlyArray<TrukiBodyNode>,
  maxLength: number
): { nodes: ReadonlyArray<TrukiBodyNode>; truncated: boolean } {
  if (countTextLength(nodes) <= maxLength) {
    return { nodes, truncated: false };
  }

  let remaining = maxLength;
  const walk = (
    list: ReadonlyArray<TrukiBodyNode>
  ): Array<TrukiBodyNode> => {
    const out: Array<TrukiBodyNode> = [];
    for (const node of list) {
      if (remaining <= 0) {
        break;
      }
      switch (node.kind) {
        case 'text': {
          if (node.text.length <= remaining) {
            out.push(node);
            remaining -= node.text.length;
          } else {
            out.push({ kind: 'text', text: node.text.slice(0, remaining) });
            remaining = 0;
          }
          break;
        }
        case 'br': {
          out.push(node);
          break;
        }
        case 'b':
        case 'i':
        case 's':
        case 'code':
        case 'pre':
        case 'link': {
          const children = walk(node.children);
          if (children.length > 0) {
            if (node.kind === 'link') {
              out.push({ kind: 'link', href: node.href, children });
            } else {
              out.push({ kind: node.kind, children });
            }
          }
          break;
        }
        default:
          throw missingCaseError(node);
      }
    }
    return out;
  };

  return { nodes: walk(nodes), truncated: true };
}
