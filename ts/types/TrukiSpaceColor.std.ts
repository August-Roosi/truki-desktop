// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

export type TrukiSpaceColorOption = Readonly<{
  /** i18n-free stable key, used as the swatch's test id and aria label key */
  key: string;
  /** 0xAARRGGBB */
  value: number;
}>;

/**
 * Fixed palette. Values are chosen to hold contrast as a button fill in both
 * light and dark themes. Arbitrary custom colours are out of scope.
 */
export const PALETTE: ReadonlyArray<TrukiSpaceColorOption> = [
  { key: 'blue', value: 0xff2c6bed },
  { key: 'indigo', value: 0xff5151f6 },
  { key: 'purple', value: 0xff8d4cc3 },
  { key: 'magenta', value: 0xffc34a9c },
  { key: 'crimson', value: 0xffcc2d4e },
  { key: 'orange', value: 0xffd96b1e },
  { key: 'amber', value: 0xffb8890a },
  { key: 'green', value: 0xff3a7d44 },
  { key: 'teal', value: 0xff1a7f78 },
  { key: 'slate', value: 0xff5c6b7a },
];

/**
 * proto3 `fixed32` has no presence, so 0 on the wire means "unset".
 * A real colour always has a non-zero alpha byte.
 */
export function fromWire(color: number): number | null {
  return color === 0 ? null : color;
}

/** Inverse of fromWire. */
export function toWire(color: number | null): number {
  return color ?? 0;
}

/** 0xAARRGGBB -> '#rrggbb'. Alpha is dropped; the accent is always opaque. */
export function toCssHex(color: number): string {
  // oxlint-disable-next-line no-bitwise
  const rgb = color & 0x00ffffff;
  return `#${rgb.toString(16).padStart(6, '0')}`;
}
