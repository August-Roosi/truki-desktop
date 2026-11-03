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

// Every write is a read-modify-write of one storage key, so they run one
// after another; two concurrent writes would each start from the same
// snapshot and the later put would drop the earlier one.
let writeQueue: Promise<void> = Promise.resolve();

async function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const previous = writeQueue;
  let release: () => void = () => undefined;
  // Resolved in `finally`, so a failed write cannot wedge the queue.
  writeQueue = new Promise<void>(resolve => {
    release = resolve;
  });
  try {
    await previous;
    await task();
  } finally {
    release();
  }
}

export function setTrukiSpaceMembers(
  folderId: string,
  m: {
    chatIds: ReadonlyArray<string>;
    networks: ReadonlyArray<string>;
  }
): Promise<void> {
  return enqueueWrite(async () => {
    await itemStorage.put('trukiSpaceBridgedMembers', {
      ...getTrukiSpaceMembers(),
      [folderId]: m,
    });
  });
}

// "Add to Space…": adds one bridged chat to a Space's chat ids.
export function addTrukiChatToSpace(
  folderId: string,
  chatId: string
): Promise<void> {
  return enqueueWrite(async () => {
    const current = getTrukiSpaceMembers();
    const entry = current[folderId] ?? { chatIds: [], networks: [] };
    if (entry.chatIds.includes(chatId)) {
      return;
    }
    await itemStorage.put('trukiSpaceBridgedMembers', {
      ...current,
      [folderId]: { ...entry, chatIds: [...entry.chatIds, chatId] },
    });
  });
}

export function removeTrukiSpace(folderId: string): Promise<void> {
  return enqueueWrite(async () => {
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
  });
}

const NEW_SPACE_TIMEOUT_MS = 10_000;

// Creating a Space gives it an id inside the create action, so the editor
// cannot know it up front. Members written before the folder is in redux's
// current chat folders would be pruned as belonging to a vanished Space, so
// wait for exactly one new folder id to appear, then write under it.
export async function saveTrukiMembersForNewSpace(options: {
  knownFolderIds: ReadonlySet<string>;
  create: () => unknown;
  getFolderIds: () => ReadonlyArray<string>;
  subscribe: (callback: () => void) => () => void;
  members: {
    chatIds: ReadonlyArray<string>;
    networks: ReadonlyArray<string>;
  };
  timeoutMs?: number;
}): Promise<string | undefined> {
  const { knownFolderIds, getFolderIds, subscribe } = options;
  await options.create();

  const findNewIds = (): ReadonlyArray<string> =>
    getFolderIds().filter(id => !knownFolderIds.has(id));

  const newIds = await new Promise<ReadonlyArray<string>>(resolve => {
    const handles: {
      unsubscribe?: () => void;
      timer?: ReturnType<typeof setTimeout>;
    } = {};
    const finish = (ids: ReadonlyArray<string>): void => {
      handles.unsubscribe?.();
      clearTimeout(handles.timer);
      resolve(ids);
    };
    const check = (): void => {
      const ids = findNewIds();
      if (ids.length > 0) {
        finish(ids);
      }
    };
    handles.unsubscribe = subscribe(check);
    handles.timer = setTimeout(
      () => finish([]),
      options.timeoutMs ?? NEW_SPACE_TIMEOUT_MS
    );
    check();
  });

  // More than one new id (a sync landed meanwhile) is ambiguous: write none.
  const [newId] = newIds;
  if (newIds.length !== 1 || newId == null) {
    return undefined;
  }
  await setTrukiSpaceMembers(newId, options.members);
  return newId;
}
