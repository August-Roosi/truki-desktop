// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useId, useMemo, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';

import { AxoCheckbox } from '../../../axo/AxoCheckbox.dom.tsx';
import { tw } from '../../../axo/tw.dom.tsx';
import type { TrukiBridgedChatSummary } from '../../../state/ducks/trukiBridge.preload.ts';
import type { LocalizerType } from '../../../types/I18N.std.ts';
import {
  setTrukiSpaceChat,
  setTrukiSpaceNetwork,
  type TrukiSpaceMembersEntry,
} from '../../../util/trukiSpaceMembersEdit.std.ts';
import { SettingsRow } from '../../PreferencesUtil.dom.tsx';

export type TrukiSpaceOtherNetworksProps = Readonly<{
  i18n: LocalizerType;
  // Networks with a connected account; the caller filters.
  networks: ReadonlyArray<Readonly<{ id: string; name: string }>>;
  chats: ReadonlyArray<TrukiBridgedChatSummary>;
  value: TrukiSpaceMembersEntry;
  onChange: (value: TrukiSpaceMembersEntry) => void;
}>;

/**
 * The Space editor's "Other networks" section: a checkbox per connected
 * network for all its chats, and a searchable list of individual chats.
 */
export function TrukiSpaceOtherNetworks(
  props: TrukiSpaceOtherNetworksProps
): JSX.Element | null {
  const { i18n, networks, chats, value, onChange } = props;
  const [search, setSearch] = useState('');
  const idPrefix = useId();

  const handleSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSearch(event.target.value);
    },
    []
  );

  const networkNames = useMemo(
    () => new Map(networks.map(network => [network.id, network.name])),
    [networks]
  );

  // Chats of a network that is selected as a whole are already in; only the
  // rest are picked one by one.
  const pickableChats = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return chats.filter(
      chat =>
        networkNames.has(chat.network) &&
        !value.networks.includes(chat.network) &&
        (needle === '' || chat.name.toLowerCase().includes(needle))
    );
  }, [chats, networkNames, search, value.networks]);

  if (networks.length === 0) {
    return null;
  }

  return (
    <SettingsRow title={i18n('icu:TrukiSpaceOtherNetworks__Title')}>
      <div
        className={tw('flex flex-col gap-2')}
        data-testid="TrukiSpaceOtherNetworks"
      >
        <div className={`Preferences__padding ${tw('flex flex-col gap-2')}`}>
          {networks.map(network => {
            const id = `${idPrefix}-network-${network.id}`;
            return (
              <div key={network.id} className={tw('flex items-center gap-3')}>
                <AxoCheckbox.Root
                  id={id}
                  variant="square"
                  checked={value.networks.includes(network.id)}
                  onCheckedChange={checked => {
                    onChange(setTrukiSpaceNetwork(value, network.id, checked));
                  }}
                />
                <label htmlFor={id} className={tw('type-body-medium')}>
                  {i18n('icu:TrukiSpaceOtherNetworks__AllChats', {
                    network: network.name,
                  })}
                </label>
              </div>
            );
          })}
        </div>
        <div className="Preferences__padding">
          <input
            type="search"
            value={search}
            onChange={handleSearchChange}
            placeholder={i18n('icu:TrukiSpaceOtherNetworks__SearchPlaceholder')}
            aria-label={i18n('icu:TrukiSpaceOtherNetworks__SearchPlaceholder')}
            className={tw(
              'w-full rounded-lg border border-secondary bg-primary px-3 py-1.5',
              'type-body-medium text-primary outline-none',
              'keyboard-mode:focus:axo-focus-ring'
            )}
          />
        </div>
        <div
          className={tw('flex max-h-64 flex-col gap-1 overflow-y-auto')}
          role="group"
          aria-label={i18n('icu:TrukiSpaceOtherNetworks__Title')}
        >
          {pickableChats.length === 0 && (
            <div
              className={`Preferences__padding ${tw('type-body-medium text-secondary')}`}
            >
              {i18n('icu:TrukiSpaceOtherNetworks__NoResults')}
            </div>
          )}
          {pickableChats.map(chat => {
            const id = `${idPrefix}-chat-${chat.id}`;
            return (
              <div
                key={chat.id}
                className={`Preferences__padding ${tw('flex items-center gap-3')}`}
              >
                <AxoCheckbox.Root
                  id={id}
                  variant="round"
                  checked={value.chatIds.includes(chat.id)}
                  onCheckedChange={checked => {
                    onChange(setTrukiSpaceChat(value, chat.id, checked));
                  }}
                />
                <label
                  htmlFor={id}
                  className={tw('min-w-0 flex-1 truncate type-body-medium')}
                  dir="auto"
                >
                  {chat.name}
                </label>
                <span className={tw('shrink-0 type-caption text-secondary')}>
                  {networkNames.get(chat.network)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </SettingsRow>
  );
}
