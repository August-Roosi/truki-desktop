// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import { AxoButton } from '../../axo/AxoButton.dom.tsx';
import { isLinkSneaky } from '../../types/LinkPreview.std.ts';
import type { LocalizerType } from '../../types/Util.std.ts';
import { missingCaseError } from '../../util/missingCaseError.std.ts';
import {
  parseTrukiFormattedBody,
  truncateTrukiBody,
  type TrukiBodyNode,
} from '../../util/trukiFormattedBody.std.ts';

const DEFAULT_MAX_LENGTH = 4000;
const WEB_URL_PATTERN = /^https?:/i;

type PropsType = Readonly<{
  i18n: LocalizerType;
  body: string;
  formattedBody?: string;
  format?: string;
  maxLength?: number;
}>;

function renderNodes(nodes: ReadonlyArray<TrukiBodyNode>): Array<ReactNode> {
  const results: Array<ReactNode> = [];
  let count = 0;
  for (const node of nodes) {
    switch (node.kind) {
      case 'text': {
        results.push(node.text);
        break;
      }
      case 'br': {
        count += 1;
        results.push(<br key={count} />);
        break;
      }
      case 'b': {
        count += 1;
        results.push(<strong key={count}>{renderNodes(node.children)}</strong>);
        break;
      }
      case 'i': {
        count += 1;
        results.push(<em key={count}>{renderNodes(node.children)}</em>);
        break;
      }
      case 's': {
        count += 1;
        results.push(<s key={count}>{renderNodes(node.children)}</s>);
        break;
      }
      case 'code': {
        count += 1;
        results.push(<code key={count}>{renderNodes(node.children)}</code>);
        break;
      }
      case 'pre': {
        count += 1;
        results.push(<pre key={count}>{renderNodes(node.children)}</pre>);
        break;
      }
      case 'link': {
        count += 1;
        // The parser only lets http, https and mailto: through; for web links
        // we also follow Signal's sneaky-link handling from Linkify.
        if (
          WEB_URL_PATTERN.test(node.href) &&
          isLinkSneaky(node.href) === 'yes'
        ) {
          results.push(<span key={count}>{renderNodes(node.children)}</span>);
          break;
        }
        results.push(
          <a key={count} href={node.href}>
            {renderNodes(node.children)}
          </a>
        );
        break;
      }
      default:
        throw missingCaseError(node);
    }
  }
  return results;
}

export function TrukiFormattedBody({
  i18n,
  body,
  formattedBody,
  format,
  maxLength = DEFAULT_MAX_LENGTH,
}: PropsType): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const parsed = useMemo<ReadonlyArray<TrukiBodyNode>>(() => {
    if (format === 'org.matrix.custom.html' && formattedBody) {
      return parseTrukiFormattedBody(formattedBody);
    }
    return [{ kind: 'text', text: body }];
  }, [body, formattedBody, format]);

  const { nodes, truncated } = useMemo(() => {
    if (expanded) {
      return { nodes: parsed, truncated: false };
    }
    return truncateTrukiBody(parsed, maxLength);
  }, [parsed, expanded, maxLength]);

  return (
    <>
      {renderNodes(nodes)}
      {truncated ? (
        <AxoButton.Root
          variant="implied-primary"
          size="sm"
          arrow="expand"
          onClick={() => {
            setExpanded(true);
          }}
        >
          {i18n('icu:TrukiFormattedBody--ShowMore')}
        </AxoButton.Root>
      ) : null}
    </>
  );
}
