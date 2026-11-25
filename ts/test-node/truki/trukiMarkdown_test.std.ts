// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import {
  getTrukiRichPlainText,
  parseTrukiMarkdown,
} from '../../util/trukiMarkdown.std.ts';
import type { TrukiMdNode, TrukiMdRoot } from '../../util/trukiMarkdown.std.ts';
import { TRUKI_RICH_MARKER as M } from '../../util/trukiRichMessage.std.ts';

const CARD_BODY = `${M}Intro **text**\n\n\`\`\`options\n? Which environment?\n- Staging\n- Production\n\`\`\``;
const INVALID_BODY = `${M}\`\`\`options\n? Pick\n- Only\n\`\`\``;

type AnyNode = TrukiMdRoot | TrukiMdNode;

function all(root: TrukiMdRoot): Array<AnyNode> {
  const out: Array<AnyNode> = [];
  const visit = (node: AnyNode) => {
    out.push(node);
    if ('children' in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(root);
  return out;
}

function texts(root: TrukiMdRoot): string {
  return all(root)
    .map(n => ('value' in n && n.type !== 'code' ? n.value : ''))
    .join('');
}

describe('trukiMarkdown', () => {
  it('renders raw html as text', () => {
    const { root } = parseTrukiMarkdown(`${M}hi <b>x</b>`);
    assert.isFalse(all(root).some(n => n.type === 'html'));
    assert.include(texts(root), '<b>');
  });

  it('turns images into links', () => {
    const { root } = parseTrukiMarkdown(`${M}![logo](https://a/b.png)`);
    assert.isFalse(all(root).some(n => n.type === 'image'));
    const link = all(root).find(n => n.type === 'link');
    assert.strictEqual(link?.type === 'link' && link.url, 'https://a/b.png');
    assert.include(texts(root), 'logo');

    const bare = parseTrukiMarkdown(`${M}![](https://a/c.png)`).root;
    assert.include(texts(bare), 'https://a/c.png');
  });

  it('makes unsafe schemes text', () => {
    const { root } = parseTrukiMarkdown(`${M}[x](javascript:alert(1)) ok`);
    assert.isFalse(all(root).some(n => n.type === 'link'));
    assert.include(texts(root), 'x');

    const mail = parseTrukiMarkdown(`${M}[m](mailto:a@b.ee)`).root;
    assert.isTrue(all(mail).some(n => n.type === 'link'));
  });

  it('removes the options block only for a valid card', () => {
    const valid = parseTrukiMarkdown(CARD_BODY);
    assert.strictEqual(valid.card?.question, 'Which environment?');
    assert.isFalse(
      all(valid.root).some(n => n.type === 'code' && n.lang === 'options')
    );
    assert.include(texts(valid.root), 'Intro');

    const invalid = parseTrukiMarkdown(INVALID_BODY);
    assert.isNull(invalid.card);
    assert.isTrue(
      all(invalid.root).some(n => n.type === 'code' && n.lang === 'options')
    );
  });

  it('parses gfm', () => {
    const { root } = parseTrukiMarkdown(
      `${M}| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n~~old~~ text[^1]\n\n[^1]: note`
    );
    const types = new Set(all(root).map(n => n.type));
    assert.isTrue(types.has('table'));
    assert.isTrue(types.has('delete'));
    assert.isTrue(types.has('footnoteReference'));
    assert.isTrue(
      all(root).some(n => n.type === 'listItem' && n.checked === true)
    );
  });

  it('caps input length', () => {
    const started = Date.now();
    const { root } = parseTrukiMarkdown(`${M}${'word '.repeat(40000)}`);
    assert.isBelow(Date.now() - started, 2000);
    assert.isAtMost(root.position?.end.offset ?? 0, 65536);
  });

  describe('plain text', () => {
    it('is the question for a card', () => {
      assert.strictEqual(
        getTrukiRichPlainText(CARD_BODY),
        'Which environment?'
      );
    });

    it('flattens markdown', () => {
      assert.strictEqual(
        getTrukiRichPlainText(`${M}# T\n\n**b** text`),
        'T\nb text'
      );
    });

    it('leaves a body without the marker unchanged', () => {
      assert.strictEqual(getTrukiRichPlainText('**b**'), '**b**');
    });

    it('is capped at 500 chars', () => {
      assert.isAtMost(
        getTrukiRichPlainText(`${M}${'a'.repeat(2000)}`).length,
        500
      );
    });
  });
});
