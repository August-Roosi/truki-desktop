// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import type { LanguageTag } from '@signalapp/types';

import { AxoProvider } from '../../axo/AxoProvider.dom.tsx';
import type { AxoIntl } from '../../axo/_internal/AxoIntl.dom.tsx';
import { TrukiRichBody } from '../../components/truki/TrukiRichBody.dom.tsx';
import type { TrukiCardMessageProps } from '../../components/truki/TrukiRichBody.dom.tsx';
import { setupI18n } from '../../util/setupI18n.dom.tsx';
import { TRUKI_RICH_MARKER as M } from '../../util/trukiRichMessage.std.ts';
import enMessages from '../../../_locales/en/messages.json' with { type: 'json' };

const i18n = setupI18n('en', enMessages);

const AXO_MESSAGES: AxoIntl.Messages = {
  'AxoAlertDialog.Cancel': 'Cancel',
  'AxoButton.Pending': 'Pending',
  'AxoDialog.Back': 'Back',
  'AxoDialog.Close': 'Close',
  'AxoTextField.Clear': 'Clear',
  'AxoPasswordField.Reveal': 'Show Password',
  'AxoBadge.MaxOverflow': (max: number) => `${max}+`,
  'AxoContactName.InSystemContactsLabel': 'In contacts',
};

function withAxo(node: JSX.Element): string {
  return renderToStaticMarkup(
    <AxoProvider
      resolvedAppLocale={{
        tag: 'en' as AxoIntl.AppLocaleTag,
        direction: 'ltr',
      }}
      systemPreferredLanguages={new Set(['en' as LanguageTag])}
      messages={AXO_MESSAGES}
    >
      {node}
    </AxoProvider>
  );
}

const noop = () => undefined;
function cardProps(
  answer: TrukiCardMessageProps['answer'] = null
): TrukiCardMessageProps {
  return { answer, sendAnswer: noop, startOtherAnswer: noop };
}

const SINGLE = `${M}Pick one:\n\n\`\`\`options\n? Deploy?\n- Staging — safe, nobody notices\n- Production — users get the fix now\n\`\`\``;
const MULTI = `${M}\`\`\`options\n? Which?\n- Staging\n- Production\nmulti: yes\nother: no\n\`\`\``;
const INVALID = `${M}\`\`\`options\n? Pick\n- Only\n\`\`\``;

function render(
  text: string,
  options: {
    direction?: 'incoming' | 'outgoing';
    trukiCard?: TrukiCardMessageProps;
    disableLinks?: boolean;
  } = {}
): string {
  return withAxo(
    <TrukiRichBody
      i18n={i18n}
      text={text}
      direction={options.direction ?? 'incoming'}
      trukiCard={options.trukiCard}
      disableLinks={options.disableLinks ?? false}
    />
  );
}

function isDisabled(tag: string | undefined): boolean {
  return /aria-disabled="true"|\sdisabled=""/.test(tag ?? '');
}

function buttons(markup: string): Array<string> {
  return markup.match(/<button[^>]*>/g) ?? [];
}

describe('TrukiRichBody', () => {
  it('renders markdown', () => {
    const markup = render(
      `${M}# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>`
    );
    assert.include(markup, '<table');
    assert.include(markup, 'Report');
    assert.include(markup, '&lt;script&gt;');
    assert.notInclude(markup, '<script>');
  });

  it('renders the card', () => {
    const markup = render(SINGLE, { trukiCard: cardProps() });
    assert.include(markup, 'Pick one:');
    assert.include(markup, 'Deploy?');
    assert.include(markup, 'Staging');
    assert.include(markup, 'safe, nobody notices');
    assert.include(markup, 'Other…');
    const all = buttons(markup);
    assert.lengthOf(all, 3);
    for (const b of all) {
      assert.isFalse(isDisabled(b), b);
    }
    assert.notInclude(markup, '```options');
  });

  it('renders a multi card with checkboxes and a disabled send', () => {
    const markup = render(MULTI, { trukiCard: cardProps() });
    assert.include(markup, 'role="checkbox"');
    assert.include(markup, 'Send');
    assert.notInclude(markup, 'Other…');
    const send = /<button([^>]*)>(?:(?!<\/button>).)*Send/.exec(markup);
    assert.isNotNull(send);
    assert.isTrue(isDisabled(send?.[1]));
  });

  it('disables an answered card and highlights the choice', () => {
    const markup = render(SINGLE, {
      trukiCard: cardProps({ selected: ['Staging'], other: null }),
    });
    for (const b of buttons(markup)) {
      assert.isTrue(isDisabled(b), b);
    }
    assert.match(
      markup,
      /aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Staging/
    );
    assert.include(markup, 'Answered');
  });

  it('shows the other text of an answer', () => {
    const markup = render(SINGLE, {
      trukiCard: cardProps({ selected: [], other: 'tomorrow' }),
    });
    assert.include(markup, 'Other: tomorrow');
  });

  it('makes an outgoing card read-only', () => {
    const markup = render(SINGLE, {
      direction: 'outgoing',
      trukiCard: cardProps(),
    });
    const all = buttons(markup);
    assert.isNotEmpty(all);
    for (const b of all) {
      assert.isTrue(isDisabled(b), b);
    }
  });

  it('makes a card without actions read-only', () => {
    for (const b of buttons(render(SINGLE))) {
      assert.isTrue(isDisabled(b), b);
    }
  });

  it('renders a sneaky link as text', () => {
    const markup = render(
      `${M}[x](https://xn--80ak6aa92e.com/) and [ok](https://example.com)`
    );
    assert.notInclude(markup, 'href="https://xn--80ak6aa92e.com/"');
    assert.include(markup, 'href="https://example.com"');
  });

  it('renders an invalid card as code', () => {
    const markup = render(INVALID, { trukiCard: cardProps() });
    assert.include(markup, '<pre');
    assert.include(markup, '? Pick');
    assert.lengthOf(buttons(markup), 0);
  });

  it('keeps reference definitions to safe schemes', () => {
    const markup = render(
      `${M}[a][x] [b][y] [c][z]\n\n[x]: javascript:alert(1)\n[y]: file:///etc/passwd\n[z]: https://example.com/ok`
    );
    assert.notMatch(markup, /javascript:/);
    assert.notInclude(markup, 'file:');
    assert.include(markup, 'href="https://example.com/ok"');
  });

  it('renders no links when links are disabled', () => {
    const markup = render(`${M}[ok](https://example.com) https://example.org`, {
      disableLinks: true,
    });
    assert.notInclude(markup, '<a');
    assert.include(markup, 'ok');
  });

  it('shows the real host when link text looks like another address', () => {
    const markup = render(`${M}[https://lhv.ee/login](https://evil.example/x)`);
    // visible text (outside attributes) must name the real host
    assert.match(markup, />[^<]*evil\.example/);
    const same = render(`${M}[https://example.com/a](https://example.com/b)`);
    assert.notInclude(same, '(example.com)');
  });

  it('falls back to plain text for unsafe markdown', () => {
    const deep = `${M}${'- '.repeat(5000)}a`;
    const started = Date.now();
    const markup = render(deep);
    assert.isBelow(Date.now() - started, 500);
    assert.notInclude(markup, '<li');
    assert.include(markup, '- - -');
  });

  it('renders footnotes and reference links', () => {
    const markup = render(
      `${M}See [docs][d] and a note[^n].\n\n[d]: https://example.com/docs\n[^n]: The note.`
    );
    assert.include(markup, 'href="https://example.com/docs"');
    assert.include(markup, 'The note.');
  });
});
