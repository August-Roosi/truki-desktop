// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import type { ChatFolderId } from '../../types/ChatFolder.std.ts';
import type { DefaultConversationColorType } from '../../types/Colors.std.ts';
import { getConversationColorAttributes } from '../../util/getConversationColorAttributes.std.ts';
import { getTrukiConversationDefaultColor } from '../../util/getTrukiConversationDefaultColor.std.ts';

const GLOBAL_DEFAULT: DefaultConversationColorType = { color: 'ultramarine' };
const SPACE_ID = '67eb3aca-a3a7-4fb8-968d-e44c8f492e0f' as ChatFolderId;

describe('getTrukiConversationDefaultColor', () => {
  it('keeps the global default when the selected space has no color', () => {
    assert.strictEqual(
      getTrukiConversationDefaultColor(GLOBAL_DEFAULT, {
        id: SPACE_ID,
        color: null,
      }),
      GLOBAL_DEFAULT
    );
  });

  it('converts the selected space color to an exact solid custom color', () => {
    assert.deepEqual(
      getTrukiConversationDefaultColor(GLOBAL_DEFAULT, {
        id: SPACE_ID,
        color: 0xff2c6bed,
      }),
      {
        color: 'custom',
        customColorData: {
          id: `truki-space:${SPACE_ID}`,
          value: {
            start: {
              hue: 220.4145077720207,
              saturation: 84.27947598253276,
              lightness: 0.5509803921568628,
            },
          },
        },
      }
    );
  });

  it('still lets an individual conversation color override the space color', () => {
    const spaceDefault = getTrukiConversationDefaultColor(GLOBAL_DEFAULT, {
      id: SPACE_ID,
      color: 0xff2c6bed,
    });

    assert.deepInclude(
      getConversationColorAttributes(
        { conversationColor: 'crimson' },
        spaceDefault
      ),
      {
        conversationColor: 'crimson',
        customColor: undefined,
        customColorId: undefined,
      }
    );
  });
});
