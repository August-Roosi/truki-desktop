// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { action } from '@storybook/addon-actions';
import type { Meta } from '@storybook/react';

import type {
  TrukiBridgedChatSummary,
  TrukiBridgedEvent,
} from '../../state/ducks/trukiBridge.preload.ts';
import type { TrukiBridgedConversationProps } from './TrukiBridgedConversation.dom.tsx';
import { TrukiBridgedConversation } from './TrukiBridgedConversation.dom.tsx';

const { i18n } = window.SignalContext;

export default {
  title: 'Components/Truki/TrukiBridgedConversation',
  parameters: { layout: 'fullscreen' },
} satisfies Meta<TrukiBridgedConversationProps>;

const ME = '@me:truki.local';
const THEM = '@whatsapp_1:truki.local';
const NOW = Date.now();
const MEDIA = `mxc://truki.local/${'0'.repeat(64)}`;

const CHAT: TrukiBridgedChatSummary = {
  id: '!chat:truki.local',
  network: 'whatsapp',
  loginId: 'login-1',
  name: 'Mari Maasikas',
  isDM: true,
  unreadCount: 0,
  lastActivity: NOW,
};

let order = 0;
function ev(
  id: string,
  overrides: Partial<TrukiBridgedEvent> = {}
): TrukiBridgedEvent {
  order += 1;
  return {
    id,
    chatId: CHAT.id,
    sender: THEM,
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: `Message ${id}` },
    timestamp: NOW - (100 - order) * 60 * 1000,
    streamOrder: order,
    status: '',
    redacted: false,
    ...overrides,
  };
}

function text(body: string): unknown {
  return { msgtype: 'm.text', body };
}

function mine(
  id: string,
  body: string,
  overrides: Partial<TrukiBridgedEvent> = {}
): TrukiBridgedEvent {
  return ev(id, {
    sender: ME,
    status: 'sent',
    content: text(body),
    ...overrides,
  });
}

function Conversation(
  props: Partial<TrukiBridgedConversationProps>
): JSX.Element {
  return (
    <div style={{ height: '100vh', width: '100%' }}>
      <TrukiBridgedConversation
        i18n={i18n}
        chatId={CHAT.id}
        chat={CHAT}
        events={[]}
        hasOlder={false}
        loading={false}
        localUserId={ME}
        networkName="WhatsApp"
        accountName="+372 5555 1234"
        bridgeState="running"
        accountState="CONNECTED"
        typingUsers={[]}
        onLoadOlder={action('onLoadOlder')}
        onMarkRead={action('onMarkRead')}
        onSend={action('onSend')}
        onReact={action('onReact')}
        onRedact={action('onRedact')}
        onRetry={action('onRetry')}
        onSetMuted={action('onSetMuted')}
        onAttach={async (caption, replyTo) => {
          action('onAttach')(caption, replyTo);
          return false;
        }}
        onDismissError={action('onDismissError')}
        {...props}
      />
    </div>
  );
}

export function Pending(): JSX.Element {
  return (
    <Conversation
      events={[
        ev('$1', { content: text('Kas homme kell 10 sobib?') }),
        mine('$truki-2', 'Sobib, näeme!', { status: 'pending' }),
      ]}
    />
  );
}

export function Failed(): JSX.Element {
  return (
    <Conversation
      events={[
        ev('$1'),
        mine('$truki-2', 'This one failed', {
          status: 'failed',
          errorCode: 'm.foreign_network_error',
        }),
        mine('$truki-3', 'This one was rate limited', {
          status: 'failed',
          errorCode: 'RATE_LIMITED',
        }),
      ]}
      error={{ code: 'RATE_LIMITED', message: 'rate limited' }}
    />
  );
}

export function Redacted(): JSX.Element {
  return (
    <Conversation
      events={[
        ev('$1', { redacted: true, content: {} }),
        mine('$2', '', { redacted: true, content: {} }),
        ev('$3', { content: text('Still here') }),
      ]}
    />
  );
}

export function Edited(): JSX.Element {
  return (
    <Conversation
      events={[
        ev('$1', { content: text('See you at 9') }),
        ev('$e1', {
          relatesTo: '$1',
          relType: 'm.replace',
          content: {
            msgtype: 'm.text',
            body: '* See you at 10',
            'm.new_content': text('See you at 10'),
          },
        }),
      ]}
    />
  );
}

export function Reply(): JSX.Element {
  return (
    <Conversation
      events={[
        mine('$1', 'Did you get the tickets?'),
        ev('$2', {
          content: {
            msgtype: 'm.text',
            body: 'Yes, two of them',
            'm.relates_to': { 'm.in_reply_to': { event_id: '$1' } },
          },
        }),
        mine('$3', 'Great', {
          content: {
            msgtype: 'm.text',
            body: 'Great',
            'm.relates_to': { 'm.in_reply_to': { event_id: '$missing' } },
          },
        }),
      ]}
    />
  );
}

export function Reactions(): JSX.Element {
  const reaction = (
    id: string,
    key: string,
    overrides: Partial<TrukiBridgedEvent> = {}
  ) =>
    ev(id, {
      type: 'm.reaction',
      relatesTo: '$1',
      relType: 'm.annotation',
      content: {
        'm.relates_to': { rel_type: 'm.annotation', event_id: '$1', key },
      },
      ...overrides,
    });
  return (
    <Conversation
      events={[
        ev('$1', { content: text('We won!') }),
        reaction('$r1', '🎉'),
        reaction('$r2', '🎉', { sender: ME, status: 'sent' }),
        reaction('$r3', '❤️'),
      ]}
    />
  );
}

export function Image(): JSX.Element {
  return (
    <Conversation
      events={[
        ev('$1', {
          content: {
            msgtype: 'm.image',
            body: 'beach.jpg',
            url: MEDIA,
            info: { w: 400, h: 300 },
          },
        }),
        mine('$2', '', {
          content: { msgtype: 'm.video', body: 'clip.mp4', url: MEDIA },
        }),
      ]}
    />
  );
}

export function File(): JSX.Element {
  return (
    <Conversation
      events={[
        ev('$1', {
          content: {
            msgtype: 'm.file',
            body: 'Quarterly report with a very long file name.pdf',
            info: { size: 1_234_567 },
          },
        }),
      ]}
    />
  );
}

export function LongText(): JSX.Element {
  return (
    <Conversation
      events={[
        ev('$1', { content: text('Lorem ipsum dolor sit amet. '.repeat(250)) }),
        ev('$2', {
          content: {
            msgtype: 'm.text',
            body: 'bold and code',
            format: 'org.matrix.custom.html',
            formatted_body: '<b>bold</b> and <code>code</code>',
          },
        }),
      ]}
      typingUsers={[THEM]}
    />
  );
}

export function BridgeDown(): JSX.Element {
  return (
    <Conversation
      bridgeState="gave-up"
      events={[ev('$1')]}
      onRestartBridge={action('onRestartBridge')}
    />
  );
}

export function LoggedOut(): JSX.Element {
  return (
    <Conversation
      accountState="LOGGED_OUT"
      events={[ev('$1')]}
      onReconnectAccount={action('onReconnectAccount')}
    />
  );
}

export function Unavailable(): JSX.Element {
  return <Conversation chat={undefined} />;
}

export function Loading(): JSX.Element {
  return <Conversation loading />;
}
