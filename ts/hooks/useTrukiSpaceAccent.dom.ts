// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect } from 'react';

import * as TrukiSpaceColor from '../types/TrukiSpaceColor.std.ts';

const ATTRIBUTE = 'data-truki-space-accent';
const VARIABLE = '--truki-space-accent';

/**
 * Applies the selected space's accent colour to <body>. Removing the attribute
 * restores stock Signal blue, because the override block in
 * stylesheets/_truki-spaces.scss is scoped to its presence.
 */
export function useTrukiSpaceAccent(color: number | null): void {
  useEffect(() => {
    const { body } = document;

    if (color == null) {
      body.removeAttribute(ATTRIBUTE);
      body.style.removeProperty(VARIABLE);
      return undefined;
    }

    body.setAttribute(ATTRIBUTE, '');
    body.style.setProperty(VARIABLE, TrukiSpaceColor.toCssHex(color));

    return () => {
      body.removeAttribute(ATTRIBUTE);
      body.style.removeProperty(VARIABLE);
    };
  }, [color]);
}
