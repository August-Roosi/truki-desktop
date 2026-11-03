// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  parseTrukiFormattedBody,
  truncateTrukiBody,
  type TrukiBodyNode,
} from '../../util/trukiFormattedBody.std.ts';

function textOf(nodes: ReadonlyArray<TrukiBodyNode>): string {
  return nodes
    .map(node => {
      switch (node.kind) {
        case 'text':
          return node.text;
        case 'br':
          return '';
        default:
          return textOf(node.children);
      }
    })
    .join('');
}

function depthOf(nodes: ReadonlyArray<TrukiBodyNode>): number {
  let depth = 0;
  for (const node of nodes) {
    if (node.kind === 'text' || node.kind === 'br') {
      continue;
    }
    depth = Math.max(depth, 1 + depthOf(node.children));
  }
  return depth;
}

function kindsOf(nodes: ReadonlyArray<TrukiBodyNode>): Array<string> {
  return nodes.map(node => node.kind);
}

describe('trukiFormattedBody parser', () => {
  it('parses plain text', () => {
    assert.deepEqual(parseTrukiFormattedBody('hello world'), [
      { kind: 'text', text: 'hello world' },
    ]);
  });

  it('parses empty input', () => {
    assert.deepEqual(parseTrukiFormattedBody(''), []);
  });

  it('maps bold variants to b', () => {
    assert.deepEqual(parseTrukiFormattedBody('<b>x</b>'), [
      { kind: 'b', children: [{ kind: 'text', text: 'x' }] },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('<strong>x</strong>'), [
      { kind: 'b', children: [{ kind: 'text', text: 'x' }] },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('<B>x</B>'), [
      { kind: 'b', children: [{ kind: 'text', text: 'x' }] },
    ]);
  });

  it('maps italic variants to i', () => {
    assert.deepEqual(parseTrukiFormattedBody('<i>x</i>'), [
      { kind: 'i', children: [{ kind: 'text', text: 'x' }] },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('<em>x</em>'), [
      { kind: 'i', children: [{ kind: 'text', text: 'x' }] },
    ]);
  });

  it('maps strikethrough variants to s', () => {
    assert.deepEqual(parseTrukiFormattedBody('<s>x</s>'), [
      { kind: 's', children: [{ kind: 'text', text: 'x' }] },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('<del>x</del>'), [
      { kind: 's', children: [{ kind: 'text', text: 'x' }] },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('<STRIKE>x</STRIKE>'), [
      { kind: 's', children: [{ kind: 'text', text: 'x' }] },
    ]);
  });

  it('parses code and pre', () => {
    assert.deepEqual(parseTrukiFormattedBody('<code>x</code>'), [
      { kind: 'code', children: [{ kind: 'text', text: 'x' }] },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('<pre>x</pre>'), [
      { kind: 'pre', children: [{ kind: 'text', text: 'x' }] },
    ]);
  });

  it('parses br', () => {
    const nodes = parseTrukiFormattedBody('a<br>b<br/>c');
    assert.deepEqual(kindsOf(nodes), ['text', 'br', 'text', 'br', 'text']);
    assert.equal(textOf(nodes), 'abc');
  });

  it('nests elements', () => {
    assert.deepEqual(parseTrukiFormattedBody('<b>a<i>b</i>c</b>'), [
      {
        kind: 'b',
        children: [
          { kind: 'text', text: 'a' },
          { kind: 'i', children: [{ kind: 'text', text: 'b' }] },
          { kind: 'text', text: 'c' },
        ],
      },
    ]);
  });

  it('drops script content entirely', () => {
    assert.deepEqual(parseTrukiFormattedBody('<script>alert(1)</script>hi'), [
      { kind: 'text', text: 'hi' },
    ]);
    const styled = parseTrukiFormattedBody('a<style>body{}</style>b');
    assert.equal(textOf(styled), 'ab');
    assert.deepEqual(kindsOf(styled), ['text', 'text']);
  });

  it('drops unknown tags and their attributes', () => {
    assert.deepEqual(
      parseTrukiFormattedBody('a<img src=x onerror=alert(1)>b'),
      [{ kind: 'text', text: 'ab' }]
    );
    assert.deepEqual(parseTrukiFormattedBody('<div>hello</div>'), [
      { kind: 'text', text: 'hello' },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('<!-- comment -->bye'), [
      { kind: 'text', text: 'bye' },
    ]);
  });

  it('drops a stray close tag', () => {
    assert.deepEqual(parseTrukiFormattedBody('</b>hi'), [
      { kind: 'text', text: 'hi' },
    ]);
  });

  it('keeps safe links', () => {
    assert.deepEqual(parseTrukiFormattedBody('<a href="https://e.ee">x</a>'), [
      {
        kind: 'link',
        href: 'https://e.ee',
        children: [{ kind: 'text', text: 'x' }],
      },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('<a href="mailto:a@b.ee">x</a>'), [
      {
        kind: 'link',
        href: 'mailto:a@b.ee',
        children: [{ kind: 'text', text: 'x' }],
      },
    ]);
  });

  it('drops javascript: links of every spelling', () => {
    for (const href of [
      // oxlint-disable-next-line no-script-url
      'javascript:alert(1)',
      // oxlint-disable-next-line no-script-url
      'JaVaScRiPt:alert(1)',
      'java&#x09;script:alert(1)',
      ' javascript:alert(1)',
    ]) {
      const nodes = parseTrukiFormattedBody(`<a href="${href}">x</a>`);
      assert.deepEqual(nodes, [{ kind: 'text', text: 'x' }], href);
    }
  });

  it('unwraps links without an href', () => {
    assert.deepEqual(parseTrukiFormattedBody('<a>x</a>'), [
      { kind: 'text', text: 'x' },
    ]);
  });

  it('keeps formatting inside an unwrapped link', () => {
    assert.deepEqual(
      parseTrukiFormattedBody('<a href="javascript:x"><b>y</b></a>'),
      [{ kind: 'b', children: [{ kind: 'text', text: 'y' }] }]
    );
  });

  it('decodes entities in text and href', () => {
    assert.deepEqual(
      parseTrukiFormattedBody(
        'a &amp; b &lt;tag&gt; &quot;q&quot; &#39;x&#39;'
      ),
      [{ kind: 'text', text: 'a & b <tag> "q" \'x\'' }]
    );
    assert.deepEqual(parseTrukiFormattedBody('&#65;&#x42;'), [
      { kind: 'text', text: 'AB' },
    ]);
    const nodes = parseTrukiFormattedBody(
      '<a href="https://e.ee/?a=1&amp;b=2">x</a>'
    );
    const first = nodes[0];
    if (first === undefined || first.kind !== 'link') {
      throw new Error('expected a link');
    }
    assert.equal(first.href, 'https://e.ee/?a=1&b=2');
  });

  it('treats a bare ampersand and unmatched angle bracket as text', () => {
    assert.deepEqual(parseTrukiFormattedBody('a & b'), [
      { kind: 'text', text: 'a & b' },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('a < b'), [
      { kind: 'text', text: 'a < b' },
    ]);
  });

  it('preserves RTL and zero-width characters as text', () => {
    const input = '\u202eRTL\u202c and zero\u200bwidth';
    assert.deepEqual(parseTrukiFormattedBody(input), [
      { kind: 'text', text: input },
    ]);
    assert.deepEqual(parseTrukiFormattedBody(`<b>${input}</b>`), [
      { kind: 'b', children: [{ kind: 'text', text: input }] },
    ]);
  });

  it('keeps text of unclosed tags', () => {
    assert.deepEqual(parseTrukiFormattedBody('<b>bold'), [
      { kind: 'b', children: [{ kind: 'text', text: 'bold' }] },
    ]);
    assert.deepEqual(parseTrukiFormattedBody('<b>a<i>b'), [
      {
        kind: 'b',
        children: [
          { kind: 'text', text: 'a' },
          { kind: 'i', children: [{ kind: 'text', text: 'b' }] },
        ],
      },
    ]);
  });

  it('closes all frames at the end, keeping order', () => {
    const nodes = parseTrukiFormattedBody('<i>a<b>c');
    assert.deepEqual(kindsOf(nodes), ['i']);
    assert.equal(textOf(nodes), 'ac');
    assert.equal(depthOf(nodes), 2);
  });

  it('caps nesting depth at 32', () => {
    const nodes = parseTrukiFormattedBody(`${'<b>'.repeat(100)}x`);
    assert.equal(depthOf(nodes), 32);
    assert.equal(textOf(nodes), 'x');
  });

  it('parses hostile 100 KB inputs in linear time', () => {
    const assertAllowed = (nodes: ReadonlyArray<TrukiBodyNode>): void => {
      for (const node of nodes) {
        assert.include(
          ['text', 'b', 'i', 's', 'code', 'pre', 'br', 'link'],
          node.kind
        );
        if (node.kind !== 'text' && node.kind !== 'br') {
          assertAllowed(node.children);
        }
      }
    };
    for (const input of [
      '<a '.repeat(33333),
      '<a href="x'.repeat(10000),
      '&'.repeat(1_000_000),
      '<'.repeat(100_000),
      '<b>'.repeat(50_000),
    ]) {
      const start = performance.now();
      const nodes = parseTrukiFormattedBody(input);
      const elapsed = performance.now() - start;
      assert.isBelow(
        elapsed,
        200,
        `${input.slice(0, 12)}... (${input.length} chars) took ${elapsed}ms`
      );
      assertAllowed(nodes);
    }
  });
});

describe('trukiFormattedBody truncation', () => {
  it('returns the input untouched when it fits', () => {
    const nodes = parseTrukiFormattedBody('<b>hello</b> world');
    const result = truncateTrukiBody(nodes, 4000);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.nodes, nodes);
  });

  it('truncates a 100 000-character body', () => {
    const nodes = parseTrukiFormattedBody('a'.repeat(100000));
    const result = truncateTrukiBody(nodes, 4000);
    assert.equal(result.truncated, true);
    assert.equal(textOf(result.nodes), 'a'.repeat(4000));
  });

  it('counts only text characters and cuts mid-node', () => {
    const nodes = parseTrukiFormattedBody(
      `${'<b>xyzw</b>'.repeat(10)}${'c'.repeat(4000)}tail`
    );
    const result = truncateTrukiBody(nodes, 4000);
    assert.equal(result.truncated, true);
    assert.equal(
      textOf(result.nodes),
      `${'xyzw'.repeat(10)}${'c'.repeat(3960)}`
    );
  });

  it('drops empty containers created by the cut', () => {
    const nodes = parseTrukiFormattedBody(
      `${'a'.repeat(4000)}<b>never shown</b>`
    );
    const result = truncateTrukiBody(nodes, 4000);
    assert.equal(result.truncated, true);
    assert.deepEqual(kindsOf(result.nodes), ['text']);
    assert.equal(textOf(result.nodes), 'a'.repeat(4000));
  });

  it('truncates inside formatted elements', () => {
    const nodes = parseTrukiFormattedBody(`<b>${'a'.repeat(100)}</b>`);
    const result = truncateTrukiBody(nodes, 10);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.nodes, [
      { kind: 'b', children: [{ kind: 'text', text: 'aaaaaaaaaa' }] },
    ]);
  });
});
