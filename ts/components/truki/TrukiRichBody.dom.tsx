// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Renders a rich agent message (U+2063 marker): Markdown via mdast, plus the
// options block as a TrukiOptionsCard. Never renders HTML strings.

import { useMemo } from 'react';
import type { JSX, ReactNode } from 'react';

import { tw } from '../../axo/tw.dom.tsx';
import { isLinkSneaky } from '../../types/LinkPreview.std.ts';
import type { LocalizerType } from '../../types/Util.std.ts';
import { parseTrukiMarkdown } from '../../util/trukiMarkdown.std.ts';
import type { TrukiMdNode, TrukiMdRoot } from '../../util/trukiMarkdown.std.ts';
import type { TrukiCardAnswer } from '../../util/trukiRichMessage.std.ts';
import { TrukiOptionsCard } from './TrukiOptionsCard.dom.tsx';

export type TrukiCardMessageProps = Readonly<{
  answer: TrukiCardAnswer | null;
  sendAnswer: (body: string) => void;
  startOtherAnswer: () => void;
}>;

export type TrukiRichBodyProps = Readonly<{
  i18n: LocalizerType;
  text: string;
  direction: 'incoming' | 'outgoing';
  trukiCard?: TrukiCardMessageProps;
}>;

const MAX_DEPTH = 32;
const HEADING_STYLE_SMALL = tw('mt-2 mb-1 type-title-small');
const HEADING_STYLES: Readonly<Record<number, string>> = {
  1: tw('mt-2 mb-1 type-title-large'),
  2: tw('mt-2 mb-1 type-title-medium'),
};
const WEB_URL_PATTERN = /^https?:/i;

type AnyNode = TrukiMdRoot | TrukiMdNode;

type RenderContext = {
  definitions: Map<string, string>;
  footnotes: Array<{ id: string; node: TrukiMdNode }>;
};

function childrenOf(node: AnyNode): ReadonlyArray<TrukiMdNode> {
  return 'children' in node
    ? (node.children as ReadonlyArray<TrukiMdNode>)
    : [];
}

function textOf(node: AnyNode): string {
  if ('value' in node && typeof node.value === 'string') {
    return node.value;
  }
  return childrenOf(node).map(textOf).join('');
}

function collect(node: AnyNode, context: RenderContext): void {
  for (const child of childrenOf(node)) {
    if (child.type === 'definition') {
      context.definitions.set(child.identifier, child.url);
    } else if (child.type === 'footnoteDefinition') {
      context.footnotes.push({ id: child.identifier, node: child });
    }
    collect(child, context);
  }
}

function renderLink(
  url: string,
  children: ReactNode,
  key: number
): JSX.Element {
  // parseTrukiMarkdown only keeps http, https and mailto links; for web
  // links also follow Signal's sneaky-link handling, as TrukiFormattedBody.
  if (WEB_URL_PATTERN.test(url) && isLinkSneaky(url) === 'yes') {
    return <span key={key}>{children}</span>;
  }
  return (
    <a key={key} href={url}>
      {children}
    </a>
  );
}

function renderChildren(
  node: AnyNode,
  context: RenderContext,
  depth: number
): Array<ReactNode> {
  return childrenOf(node).map((child, index) =>
    renderNode(child, context, depth + 1, index)
  );
}

function renderNode(
  node: TrukiMdNode,
  context: RenderContext,
  depth: number,
  key: number
): ReactNode {
  if (depth > MAX_DEPTH) {
    return textOf(node);
  }
  const children = () => renderChildren(node, context, depth);
  switch (node.type) {
    case 'paragraph':
      return (
        <p key={key} className={tw('my-1')} dir="auto">
          {children()}
        </p>
      );
    case 'heading': {
      const style = HEADING_STYLES[node.depth] ?? HEADING_STYLE_SMALL;
      return (
        <div
          key={key}
          role="heading"
          aria-level={node.depth}
          className={style}
          dir="auto"
        >
          {children()}
        </div>
      );
    }
    case 'text':
      return node.value;
    case 'strong':
      return <strong key={key}>{children()}</strong>;
    case 'emphasis':
      return <em key={key}>{children()}</em>;
    case 'delete':
      return <s key={key}>{children()}</s>;
    case 'inlineCode':
      return (
        <code key={key} className={tw('rounded-sm bg-secondary px-1')}>
          {node.value}
        </code>
      );
    case 'code':
      return (
        <pre
          key={key}
          className={tw('my-1 overflow-x-auto rounded-md bg-secondary p-2')}
        >
          <code>{node.value}</code>
        </pre>
      );
    case 'break':
      return <br key={key} />;
    case 'thematicBreak':
      return <hr key={key} className={tw('my-2 opacity-30')} />;
    case 'blockquote':
      return (
        <blockquote key={key} className={tw('my-1 border-s-2 ps-2 opacity-80')}>
          {children()}
        </blockquote>
      );
    case 'list':
      return node.ordered ? (
        <ol
          key={key}
          start={node.start ?? undefined}
          className={tw('my-1 list-decimal ps-6')}
        >
          {children()}
        </ol>
      ) : (
        <ul key={key} className={tw('my-1 list-disc ps-6')}>
          {children()}
        </ul>
      );
    case 'listItem': {
      // A list item's first paragraph flows inline with its bullet/checkbox.
      const [first, ...rest] = childrenOf(node);
      const lead =
        first?.type === 'paragraph'
          ? renderChildren(first, context, depth + 1)
          : first && renderNode(first, context, depth + 1, 0);
      return (
        <li key={key} dir="auto">
          {node.checked != null ? (
            <span aria-hidden className={tw('me-1')}>
              {node.checked ? '☑' : '☐'}
            </span>
          ) : null}
          {lead}
          {rest.map((child, index) =>
            renderNode(child, context, depth + 1, index + 1)
          )}
        </li>
      );
    }
    case 'table':
      return (
        <div key={key} className={tw('my-1 max-w-full overflow-x-auto')}>
          <table className={tw('border-collapse')}>
            <tbody>{children()}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr key={key}>{children()}</tr>;
    case 'tableCell':
      return (
        <td
          key={key}
          className={tw('border border-primary px-2 py-1')}
          dir="auto"
        >
          {children()}
        </td>
      );
    case 'link':
      return renderLink(node.url, children(), key);
    case 'linkReference': {
      const url = context.definitions.get(node.identifier);
      return url ? renderLink(url, children(), key) : textOf(node);
    }
    case 'imageReference': {
      const url = context.definitions.get(node.identifier);
      return url ? renderLink(url, node.alt || url, key) : (node.alt ?? '');
    }
    case 'footnoteReference': {
      const index = context.footnotes.findIndex(f => f.id === node.identifier);
      return <sup key={key}>{index === -1 ? node.identifier : index + 1}</sup>;
    }
    case 'definition':
    case 'footnoteDefinition':
      return null;
    default:
      return textOf(node);
  }
}

export function TrukiRichBody({
  i18n,
  text,
  direction,
  trukiCard,
}: TrukiRichBodyProps): JSX.Element {
  const { root, card } = useMemo(() => parseTrukiMarkdown(text), [text]);
  const context = useMemo(() => {
    const result: RenderContext = { definitions: new Map(), footnotes: [] };
    collect(root, result);
    return result;
  }, [root]);

  return (
    <div className={tw('wrap-break-word select-text')}>
      {renderChildren(root, context, 0)}
      {context.footnotes.length > 0 ? (
        <ol className={tw('mt-2 list-decimal ps-6 type-caption opacity-80')}>
          {context.footnotes.map(f => (
            <li key={f.id} dir="auto">
              {renderChildren(f.node, context, 1)}
            </li>
          ))}
        </ol>
      ) : null}
      {card ? (
        <TrukiOptionsCard
          i18n={i18n}
          card={card}
          answer={trukiCard?.answer ?? null}
          disabled={direction === 'outgoing' || trukiCard == null}
          onAnswer={body => trukiCard?.sendAnswer(body)}
          onOther={() => trukiCard?.startOtherAnswer()}
        />
      ) : null}
    </div>
  );
}
