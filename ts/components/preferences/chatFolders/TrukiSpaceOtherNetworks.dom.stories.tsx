// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from 'react';
import type { JSX } from 'react';
import type { Meta } from '@storybook/react';

import type { TrukiBridgedChatSummary } from '../../../state/ducks/trukiBridge.preload.ts';
import {
  EMPTY_TRUKI_SPACE_MEMBERS,
  type TrukiSpaceMembersEntry,
} from '../../../util/trukiSpaceMembersEdit.std.ts';
import type { TrukiSpaceOtherNetworksProps } from './TrukiSpaceOtherNetworks.dom.tsx';
import { TrukiSpaceOtherNetworks } from './TrukiSpaceOtherNetworks.dom.tsx';

const { i18n } = window.SignalContext;

export default {
  title: 'Components/Truki/TrukiSpaceOtherNetworks',
} satisfies Meta<TrukiSpaceOtherNetworksProps>;

function makeChat(
  id: string,
  name: string,
  network: string
): TrukiBridgedChatSummary {
  return {
    id,
    network,
    loginId: `login-${network}`,
    name,
    isDM: true,
    unreadCount: 0,
    lastActivity: 1,
  };
}

const CHATS = [
  makeChat('wa-1', 'Mari Maasikas', 'whatsapp'),
  makeChat('wa-2', 'Perekond', 'whatsapp'),
  makeChat('m-1', 'Jaan Tamm', 'meta'),
  makeChat('ig-1', 'Kati Kask', 'instagram'),
];

function Editor(props: {
  networks: TrukiSpaceOtherNetworksProps['networks'];
  initial?: TrukiSpaceMembersEntry;
}): JSX.Element {
  const [value, setValue] = useState(
    props.initial ?? EMPTY_TRUKI_SPACE_MEMBERS
  );
  return (
    <div style={{ maxWidth: 520, padding: 24 }}>
      <TrukiSpaceOtherNetworks
        i18n={i18n}
        networks={props.networks}
        chats={CHATS}
        value={value}
        onChange={setValue}
      />
    </div>
  );
}

export function TwoNetworks(): JSX.Element {
  return (
    <Editor
      networks={[
        { id: 'whatsapp', name: 'WhatsApp' },
        { id: 'meta', name: 'Facebook Messenger' },
      ]}
    />
  );
}

export function WholeNetworkSelected(): JSX.Element {
  return (
    <Editor
      networks={[
        { id: 'whatsapp', name: 'WhatsApp' },
        { id: 'meta', name: 'Facebook Messenger' },
      ]}
      initial={{ chatIds: ['m-1'], networks: ['whatsapp'] }}
    />
  );
}
