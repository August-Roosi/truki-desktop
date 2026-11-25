// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Markdown for rich agent messages: CommonMark + GFM via mdast, with the
// Truki deviations from the spec (raw HTML as text, images as links, only
// http/https/mailto links, the options block drawn as a card instead).

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

import {
  analyzeTrukiRich,
  isTrukiMarkdownSafe,
  isTrukiRich,
  stripTrukiMarker,
} from './trukiRichMessage.std.ts';
import type { TrukiCard } from './trukiRichMessage.std.ts';

// mdast types, derived from the parser so no direct `mdast` import is needed.
export type TrukiMdRoot = ReturnType<typeof fromMarkdown>;
export type TrukiMdNode = TrukiMdRoot['children'][number];
export type TrukiMarkdown = { root: TrukiMdRoot; card: TrukiCard | null };

const MAX_PLAIN_LENGTH = 500;
export const TRUKI_SAFE_URL = /^(https?:|mailto:)/i;

function childrenOf(node: TrukiMdRoot | TrukiMdNode): Array<TrukiMdNode> {
  return 'children' in node ? (node.children as Array<TrukiMdNode>) : [];
}

// Applies the Truki deviations; returns new child lists, never mutates input.
function transformChildren(
  children: ReadonlyArray<TrukiMdNode>,
  removeOptions: boolean
): Array<TrukiMdNode> {
  const next: Array<TrukiMdNode> = [];
  for (const child of children) {
    if (
      removeOptions &&
      child.type === 'code' &&
      child.lang === 'options' &&
      !child.meta
    ) {
      continue;
    }
    if (child.type === 'html') {
      next.push({ type: 'text', value: child.value, position: child.position });
    } else if (child.type === 'image') {
      next.push({
        type: 'link',
        url: child.url,
        children: [{ type: 'text', value: child.alt || child.url }],
        position: child.position,
      });
    } else if (child.type === 'link' && !TRUKI_SAFE_URL.test(child.url)) {
      next.push(...transformChildren(childrenOf(child), false));
    } else if ('children' in child) {
      // Swaps keep phrasing as phrasing, so the parent's child type holds.
      next.push({
        ...child,
        children: transformChildren(childrenOf(child), false),
      } as TrukiMdNode);
    } else {
      next.push(child);
    }
  }
  return next;
}

// Null when the body is not safe to parse (see isTrukiMarkdownSafe) or the
// parser throws: callers fall back to plain text.
export function parseTrukiMarkdown(body: string): TrukiMarkdown | null {
  const text = stripTrukiMarker(body);
  if (!isTrukiMarkdownSafe(text)) {
    return null;
  }
  try {
    const { card } = analyzeTrukiRich(body);
    const root = fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
    // Only top-level options fences are cards (removeOptions at root only).
    return {
      root: {
        ...root,
        children: transformChildren(root.children, card != null),
      },
      card,
    };
  } catch {
    return null;
  }
}

function inlineText(nodes: ReadonlyArray<TrukiMdNode>): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'break') {
      out += ' ';
    } else if ('value' in node && typeof node.value === 'string') {
      out += node.value;
    } else if ('children' in node) {
      out += inlineText(childrenOf(node));
    }
  }
  return out;
}

function blockLines(
  node: TrukiMdRoot | TrukiMdNode,
  lines: Array<string>
): void {
  switch (node.type) {
    case 'root':
    case 'blockquote':
    case 'list':
    case 'listItem':
    case 'footnoteDefinition':
      for (const child of childrenOf(node)) {
        blockLines(child, lines);
      }
      return;
    case 'table':
      for (const row of node.children) {
        lines.push(
          row.children.map(cell => inlineText(childrenOf(cell))).join(' | ')
        );
      }
      return;
    case 'code':
      lines.push(node.value);
      return;
    case 'thematicBreak':
    case 'definition':
      return;
    default:
      lines.push(inlineText(childrenOf(node)));
  }
}

export function getTrukiRichPlainText(body: string): string {
  if (!isTrukiRich(body)) {
    return body;
  }
  const { card } = analyzeTrukiRich(body);
  if (card) {
    return card.question.slice(0, MAX_PLAIN_LENGTH);
  }
  const parsed = parseTrukiMarkdown(body);
  if (parsed == null) {
    return stripTrukiMarker(body).slice(0, MAX_PLAIN_LENGTH);
  }
  const lines: Array<string> = [];
  blockLines(parsed.root, lines);
  return lines
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_PLAIN_LENGTH);
}
