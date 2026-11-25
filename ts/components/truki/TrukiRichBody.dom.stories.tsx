// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { action } from '@storybook/addon-actions';
import type { Meta } from '@storybook/react';

import { TRUKI_RICH_MARKER as M } from '../../util/trukiRichMessage.std.ts';
import type {
  TrukiCardMessageProps,
  TrukiRichBodyProps,
} from './TrukiRichBody.dom.tsx';
import { TrukiRichBody } from './TrukiRichBody.dom.tsx';

const { i18n } = window.SignalContext;

export default {
  title: 'Components/Truki/TrukiRichBody',
} satisfies Meta<TrukiRichBodyProps>;

function card(
  answer: TrukiCardMessageProps['answer'] = null
): TrukiCardMessageProps {
  return {
    answer,
    sendAnswer: action('sendAnswer'),
    startOtherAnswer: action('startOtherAnswer'),
  };
}

function Bubble({ children }: { children: JSX.Element }): JSX.Element {
  return <div style={{ maxWidth: 420, padding: 12 }}>{children}</div>;
}

const SINGLE = `${M}The fix is **ready**.\n\n\`\`\`options\n? Which environment?\n- Staging — safe, nobody notices\n- Production — users get the fix now\n\`\`\``;

export function MarkdownReport(): JSX.Element {
  return (
    <Bubble>
      <TrukiRichBody
        i18n={i18n}
        direction="incoming"
        text={`${M}# Weekly report\n\n## Done\n\n- [x] Calendar sync\n- [ ] Bank export\n\n| Task | Hours |\n|---|---|\n| Thesis | 6 |\n| Course | 3.5 |\n\n> Quoted note with \`inline code\`.\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\nSee [the docs](https://example.com) and a footnote[^1].\n\n[^1]: Footnote text.`}
      />
    </Bubble>
  );
}

export function Single(): JSX.Element {
  return (
    <Bubble>
      <TrukiRichBody
        i18n={i18n}
        direction="incoming"
        text={SINGLE}
        trukiCard={card()}
      />
    </Bubble>
  );
}

export function Multi(): JSX.Element {
  return (
    <Bubble>
      <TrukiRichBody
        i18n={i18n}
        direction="incoming"
        text={`${M}\`\`\`options\n? Which reports?\n- Calendar\n- Bank — read-only\n- Courses\nmulti: yes\n\`\`\``}
        trukiCard={card()}
      />
    </Bubble>
  );
}

export function OtherOnly(): JSX.Element {
  return (
    <Bubble>
      <TrukiRichBody
        i18n={i18n}
        direction="incoming"
        text={`${M}\`\`\`options\n? When should I run it?\n- Now\n- Tonight\nother: yes\n\`\`\``}
        trukiCard={card()}
      />
    </Bubble>
  );
}

export function Answered(): JSX.Element {
  return (
    <Bubble>
      <TrukiRichBody
        i18n={i18n}
        direction="incoming"
        text={SINGLE}
        trukiCard={card({ selected: ['Staging'], other: 'and ping me after' })}
      />
    </Bubble>
  );
}

export function Outgoing(): JSX.Element {
  return (
    <Bubble>
      <TrukiRichBody
        i18n={i18n}
        direction="outgoing"
        text={SINGLE}
        trukiCard={card()}
      />
    </Bubble>
  );
}

export function InvalidBlock(): JSX.Element {
  return (
    <Bubble>
      <TrukiRichBody
        i18n={i18n}
        direction="incoming"
        text={`${M}\`\`\`options\n? Pick\n- Only one option\n\`\`\``}
        trukiCard={card()}
      />
    </Bubble>
  );
}

export function LongCodeLine(): JSX.Element {
  return (
    <Bubble>
      <TrukiRichBody
        i18n={i18n}
        direction="incoming"
        text={`${M}\`\`\`\n${'very_long_identifier_'.repeat(20)}\n\`\`\``}
      />
    </Bubble>
  );
}
