// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  analyzeTrukiRich,
  formatTrukiCardAnswer,
  isTrukiRich,
  resolveTrukiCardAnswer,
  stripTrukiMarker,
  TRUKI_RICH_MARKER,
} from '../../util/trukiRichMessage.std.ts';
import type { TrukiCard } from '../../util/trukiRichMessage.std.ts';

const FIXTURES = path.join(__dirname, 'fixtures', 'rich-agent-messages');

const MULTI: TrukiCard = {
  question: 'q',
  options: [
    { label: 'Staging', description: '' },
    { label: 'Production', description: '' },
    { label: 'Yes, deploy', description: '' },
  ],
  multi: true,
  other: true,
};
const SINGLE: TrukiCard = { ...MULTI, multi: false };
const NO_OTHER: TrukiCard = { ...MULTI, other: false };

describe('trukiRichMessage', () => {
  describe('fixtures', () => {
    const names = fs
      .readdirSync(FIXTURES)
      .filter(name => name.endsWith('.md'))
      .sort();

    it('has the shared fixture set', () => {
      assert.isAtLeast(names.length, 30);
    });

    for (const name of names) {
      it(name, () => {
        const body = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
        const expected = JSON.parse(
          fs.readFileSync(
            path.join(FIXTURES, name.replace(/\.md$/, '.json')),
            'utf8'
          )
        );
        assert.deepEqual(analyzeTrukiRich(body), expected);
      });
    }
  });

  describe('isTrukiRich', () => {
    it('is true only with the marker first', () => {
      assert.isTrue(isTrukiRich(`${TRUKI_RICH_MARKER}# x`));
      assert.isFalse(isTrukiRich(`# x${TRUKI_RICH_MARKER}`));
      assert.isFalse(isTrukiRich(undefined));
      assert.isFalse(isTrukiRich(null));
      assert.isFalse(isTrukiRich(''));
    });

    it('strips the marker', () => {
      assert.strictEqual(stripTrukiMarker(`${TRUKI_RICH_MARKER}# x`), '# x');
      assert.strictEqual(stripTrukiMarker('# x'), '# x');
    });
  });

  describe('resolves answers', () => {
    it('label', () => {
      assert.deepEqual(resolveTrukiCardAnswer(MULTI, '✅ Staging', true), {
        selected: ['Staging'],
        other: null,
      });
    });

    it('option order, case-insensitive', () => {
      assert.deepEqual(
        resolveTrukiCardAnswer(MULTI, '✅ production, staging', true)?.selected,
        ['Staging', 'Production']
      );
    });

    it('other after newline', () => {
      assert.deepEqual(
        resolveTrukiCardAnswer(MULTI, '✅ Staging\nalso ping me', true),
        { selected: ['Staging'], other: 'also ping me' }
      );
    });

    it('number', () => {
      assert.deepEqual(resolveTrukiCardAnswer(MULTI, '2', false), {
        selected: ['Production'],
        other: null,
      });
    });

    it('numbers on multi', () => {
      assert.deepEqual(resolveTrukiCardAnswer(MULTI, '1, 3', true)?.selected, [
        'Staging',
        'Yes, deploy',
      ]);
    });

    it('too many numbers on single', () => {
      assert.isNull(resolveTrukiCardAnswer(SINGLE, '1,3', true));
    });

    it('number out of range', () => {
      assert.isNull(resolveTrukiCardAnswer(MULTI, '4', true));
      assert.isNull(resolveTrukiCardAnswer(MULTI, '0', true));
    });

    it('unknown label', () => {
      assert.isNull(resolveTrukiCardAnswer(MULTI, '✅ Nope', true));
    });

    it('free text', () => {
      assert.deepEqual(resolveTrukiCardAnswer(MULTI, 'ship it', true), {
        selected: [],
        other: 'ship it',
      });
      assert.isNull(resolveTrukiCardAnswer(MULTI, 'ship it', false));
      assert.isNull(resolveTrukiCardAnswer(NO_OTHER, 'ship it', true));
    });

    it('other after newline not allowed', () => {
      assert.isNull(
        resolveTrukiCardAnswer(NO_OTHER, '✅ Staging\nextra', true)
      );
    });

    it('label with comma', () => {
      assert.deepEqual(
        resolveTrukiCardAnswer(MULTI, '✅ Yes, deploy, Staging', true)
          ?.selected,
        ['Staging', 'Yes, deploy']
      );
    });

    it('two labels on single', () => {
      assert.isNull(
        resolveTrukiCardAnswer(SINGLE, '✅ Staging, Production', true)
      );
    });
  });

  describe('formats answers', () => {
    it('single', () => {
      assert.strictEqual(
        formatTrukiCardAnswer(SINGLE, ['Production']),
        '✅ Production'
      );
    });

    it('multi in option order', () => {
      assert.strictEqual(
        formatTrukiCardAnswer(MULTI, ['Production', 'Staging']),
        '✅ Staging, Production'
      );
    });

    it('with other text', () => {
      assert.strictEqual(
        formatTrukiCardAnswer(MULTI, ['Staging'], 'note'),
        '✅ Staging\nnote'
      );
    });

    it('other only', () => {
      assert.strictEqual(formatTrukiCardAnswer(MULTI, [], ' later '), 'later');
    });

    it('round-trips through resolve', () => {
      const body = formatTrukiCardAnswer(
        MULTI,
        ['Yes, deploy', 'Staging'],
        'x'
      );
      assert.deepEqual(resolveTrukiCardAnswer(MULTI, body, true), {
        selected: ['Staging', 'Yes, deploy'],
        other: 'x',
      });
    });
  });
});
