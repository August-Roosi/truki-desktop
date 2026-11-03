// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { itemStorage } from '../textsecure/Storage.preload.ts';
import type { TrukiSpaceBridgedMembers } from '../types/TrukiSpaceBridgedMembers.std.ts';

export type { TrukiSpaceBridgedMembers } from '../types/TrukiSpaceBridgedMembers.std.ts';
export { trukiChatInSpace } from '../types/TrukiSpaceBridgedMembers.std.ts';

// Spaces membership lives in one item storage key; itemStorage.put feeds
// the write back into the items duck, so selectors can read it from state.

export function getTrukiSpaceMembers(): TrukiSpaceBridgedMembers {
  return itemStorage.get('trukiSpaceBridgedMembers') ?? {};
}

export async function setTrukiSpaceMembers(
  folderId: string,
  m: {
    chatIds: ReadonlyArray<string>;
    networks: ReadonlyArray<string>;
  }
): Promise<void> {
  await itemStorage.put('trukiSpaceBridgedMembers', {
    ...getTrukiSpaceMembers(),
    [folderId]: m,
  });
}

export async function removeTrukiSpace(folderId: string): Promise<void> {
  const current = getTrukiSpaceMembers();
  if (current[folderId] == null) {
    return;
  }
  const next: Record<
    string,
    {
      chatIds: ReadonlyArray<string>;
      networks: ReadonlyArray<string>;
    }
  > = {};
  for (const [id, entry] of Object.entries(current)) {
    if (id !== folderId) {
      next[id] = entry;
    }
  }
  await itemStorage.put('trukiSpaceBridgedMembers', next);
}
