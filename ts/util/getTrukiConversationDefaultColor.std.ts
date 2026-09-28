// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatFolder } from '../types/ChatFolder.std.ts';
import type { DefaultConversationColorType } from '../types/Colors.std.ts';
import { rgbIntToHSL } from './rgbToHSL.std.ts';

type TrukiSpaceColorSource = Pick<ChatFolder, 'color' | 'id'>;

/**
 * Uses the active space color as the conversation default. A conversation's
 * own color is still resolved first by getConversationColorAttributes.
 */
export function getTrukiConversationDefaultColor(
  defaultConversationColor: DefaultConversationColorType,
  selectedChatFolder: TrukiSpaceColorSource | null
): DefaultConversationColorType {
  if (selectedChatFolder?.color == null) {
    return defaultConversationColor;
  }

  const {
    h: hue,
    s: saturation,
    l: lightness,
  } = rgbIntToHSL(selectedChatFolder.color);

  return {
    color: 'custom',
    customColorData: {
      id: `truki-space:${selectedChatFolder.id}`,
      value: {
        start: {
          hue,
          saturation: saturation * 100,
          lightness,
        },
      },
    },
  };
}
