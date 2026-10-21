// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { action } from '@storybook/addon-actions';
import type { Meta } from '@storybook/react';

import type { TrukiBridgedChatSummary } from '../../state/ducks/trukiBridge.preload.ts';
import type { TrukiBridgedChatRowPropsType } from './TrukiBridgedChatRow.dom.tsx';
import { TrukiBridgedChatRow } from './TrukiBridgedChatRow.dom.tsx';

const { i18n } = window.SignalContext;

export default {
  title: 'Components/Truki/TrukiBridgedChatRow',
} satisfies Meta<TrukiBridgedChatRowPropsType>;

const NOW = Date.now();

function makeChat(
  overrides: Partial<TrukiBridgedChatSummary> = {}
): TrukiBridgedChatSummary {
  return {
    id: 'chat-1',
    network: 'whatsapp',
    loginId: 'login-1',
    name: 'Mari Maasikas',
    isDM: true,
    unreadCount: 0,
    lastActivity: NOW - 5 * 60 * 1000,
    lastEventId: '$event-1',
    preview: { text: 'Kas homme kell 10 sobib?', fromMe: false },
    ...overrides,
  };
}

function Row(
  props: Partial<TrukiBridgedChatRowPropsType> & {
    chat: TrukiBridgedChatSummary;
  }
): JSX.Element {
  return (
    <div
      className="module-conversation-list module-conversation-list--width-wide"
      style={{ width: 360 }}
    >
      <TrukiBridgedChatRow
        i18n={i18n}
        isSelected={false}
        onSelect={action('onSelect')}
        onMarkRead={action('onMarkRead')}
        onSetMuted={action('onSetMuted')}
        {...props}
      />
    </div>
  );
}

export function Default(): JSX.Element {
  return <Row chat={makeChat()} />;
}

export function Networks(): JSX.Element {
  return (
    <>
      <Row chat={makeChat({ id: 'wa', network: 'whatsapp' })} />
      <Row chat={makeChat({ id: 'fb', network: 'meta', name: 'Jaan Tamm' })} />
      <Row
        chat={makeChat({
          id: 'ig',
          network: 'instagram',
          name: 'kohvik.tartu',
          isDM: false,
        })}
      />
    </>
  );
}

export function Selected(): JSX.Element {
  return <Row chat={makeChat()} isSelected />;
}

export function Unread(): JSX.Element {
  return <Row chat={makeChat({ unreadCount: 3 })} />;
}

export function FromMe(): JSX.Element {
  return (
    <Row
      chat={makeChat({
        preview: { text: 'Sobib, näeme!', fromMe: true },
      })}
    />
  );
}

export function Muted(): JSX.Element {
  return (
    <Row
      chat={makeChat({
        unreadCount: 12,
        mutedUntil: NOW + 24 * 60 * 60 * 1000,
      })}
    />
  );
}

export function Disconnected(): JSX.Element {
  return <Row chat={makeChat({ network: 'meta' })} isDisconnected />;
}

export function NoPreviewOrActivity(): JSX.Element {
  return <Row chat={makeChat({ lastActivity: 0, preview: undefined })} />;
}

export function VeryLongName(): JSX.Element {
  return (
    <Row
      chat={makeChat({
        name: 'Tartu Ülikooli arvutiteaduse instituudi tudengite ühine vestlusgrupp 2026 sügissemester',
        isDM: false,
        preview: {
          text: 'A very long last message that keeps going and going so that it has to be cut off at the end of the row',
          fromMe: false,
        },
      })}
    />
  );
}

export function RightToLeftName(): JSX.Element {
  return (
    <Row
      chat={makeChat({
        name: 'مريم الأحمد',
        preview: { text: 'مرحبا، كيف حالك؟', fromMe: false },
      })}
    />
  );
}

export function EmojiOnlyName(): JSX.Element {
  return (
    <Row
      chat={makeChat({
        name: '🌻🐝🍯',
        network: 'instagram',
        preview: { text: '🎉🎉', fromMe: false },
      })}
    />
  );
}

export function NoContextMenuActions(): JSX.Element {
  return (
    <Row chat={makeChat()} onMarkRead={undefined} onSetMuted={undefined} />
  );
}
