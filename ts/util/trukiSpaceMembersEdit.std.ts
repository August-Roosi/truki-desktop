// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Pure edits of one Space's bridged-chat membership entry; the Space editor
// and the chat row's "Add to Space…" both build the payload for
// setTrukiSpaceMembers with these.

export type TrukiSpaceMembersEntry = Readonly<{
  chatIds: ReadonlyArray<string>;
  networks: ReadonlyArray<string>;
}>;

export const EMPTY_TRUKI_SPACE_MEMBERS: TrukiSpaceMembersEntry = {
  chatIds: [],
  networks: [],
};

function toggle(
  list: ReadonlyArray<string>,
  item: string,
  on: boolean
): ReadonlyArray<string> {
  const without = list.filter(existing => existing !== item);
  return on ? [...without, item] : without;
}

export function setTrukiSpaceNetwork(
  entry: TrukiSpaceMembersEntry,
  network: string,
  on: boolean
): TrukiSpaceMembersEntry {
  return { ...entry, networks: toggle(entry.networks, network, on) };
}

export function setTrukiSpaceChat(
  entry: TrukiSpaceMembersEntry,
  chatId: string,
  on: boolean
): TrukiSpaceMembersEntry {
  return { ...entry, chatIds: toggle(entry.chatIds, chatId, on) };
}

function sameSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every(item => b.includes(item));
}

export function isSameTrukiSpaceMembers(
  a: TrukiSpaceMembersEntry,
  b: TrukiSpaceMembersEntry
): boolean {
  return sameSet(a.chatIds, b.chatIds) && sameSet(a.networks, b.networks);
}

// The networks the editor offers: those with at least one account.
export function getTrukiConnectedNetworks(
  accounts: ReadonlyArray<Readonly<{ network: string }>>,
  networks: ReadonlyArray<Readonly<{ id: string; name: string }>>
): ReadonlyArray<{ id: string; name: string }> {
  const connected = new Set(accounts.map(account => account.network));
  const result: Array<{ id: string; name: string }> = [];
  for (const id of connected) {
    const name = networks.find(network => network.id === id)?.name;
    result.push({ id, name: name || id });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
