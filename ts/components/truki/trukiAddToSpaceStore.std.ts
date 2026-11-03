// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useSyncExternalStore } from 'react';

import type { TrukiSpaceBridgedMembers } from '../../types/TrukiSpaceBridgedMembers.std.ts';

// What a bridged chat row's "Add to Space…" menu needs: the custom Spaces,
// who is already in them, and how to add. ConversationList builds the row
// from a fixed set of props, so the left pane's Truki hook publishes this
// here and the row reads it, rather than threading it through upstream.
export type TrukiAddToSpaceOptions = Readonly<{
  spaces: ReadonlyArray<Readonly<{ id: string; name: string }>>;
  members: TrukiSpaceBridgedMembers;
  onAdd: (spaceId: string, chatId: string) => void;
}>;

let current: TrukiAddToSpaceOptions | undefined;
const listeners = new Set<() => void>();

export function setTrukiAddToSpaceOptions(
  options: TrukiAddToSpaceOptions | undefined
): void {
  current = options;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTrukiAddToSpaceOptions():
  | TrukiAddToSpaceOptions
  | undefined {
  return useSyncExternalStore(subscribe, () => current);
}
