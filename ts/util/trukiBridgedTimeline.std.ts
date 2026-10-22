// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Turns a bridged chat's raw Matrix events into what the conversation view
// shows: one item per visible message, with its latest edit applied, its
// reactions aggregated and its reply target resolved. See
// docs/truki/specs/2026-10-21-truki-inbox-design.md §4.2.

import { mxcToTrukiMediaUrl } from '../../app/truki/trukiBridgeProtocol.std.ts';
import type { TrukiSupervisorStateName } from '../../app/truki/trukiBridgeProtocol.std.ts';
import type { TrukiBridgedEvent } from '../state/ducks/trukiBridge.preload.ts';

export type TrukiTimelineContent =
  | Readonly<{
      kind: 'text';
      body: string;
      formattedBody?: string;
      format?: string;
    }>
  | Readonly<{
      kind: 'image' | 'video';
      body: string;
      url?: string;
      width?: number;
      height?: number;
    }>
  // `mxc` is set only for a bridge media id, which main can save.
  | Readonly<{ kind: 'file'; name: string; size?: number; mxc?: string }>
  | Readonly<{ kind: 'unsupported' }>;

export type TrukiTimelineReaction = Readonly<{
  key: string;
  count: number;
  // The local user's own reaction with this key, which can be removed.
  myEventId?: string;
  mine: boolean;
}>;

export type TrukiTimelineQuote = Readonly<{
  id: string;
  found: boolean;
  outgoing: boolean;
  redacted: boolean;
  content?: TrukiTimelineContent;
}>;

export type TrukiTimelineItem = Readonly<{
  id: string;
  sender: string;
  outgoing: boolean;
  timestamp: number;
  status: TrukiBridgedEvent['status'];
  errorCode?: string;
  redacted: boolean;
  edited: boolean;
  content: TrukiTimelineContent;
  replyTo?: TrukiTimelineQuote;
  reactions: ReadonlyArray<TrukiTimelineReaction>;
}>;

export const TRUKI_RATE_LIMITED = 'RATE_LIMITED';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function isTrukiOutgoingEvent(
  event: TrukiBridgedEvent,
  localUserId: string
): boolean {
  return event.sender === localUserId || event.status !== '';
}

function isTimelineMessage(event: TrukiBridgedEvent): boolean {
  return (
    (event.type === 'm.room.message' || event.type === 'm.sticker') &&
    event.relType !== 'm.replace'
  );
}

export function parseTrukiTimelineContent(
  type: string,
  content: unknown
): TrukiTimelineContent {
  if (!isRecord(content)) {
    return { kind: 'unsupported' };
  }
  const body = str(content.body) ?? '';
  const info = isRecord(content.info) ? content.info : {};
  const url = str(content.url);
  const mediaUrl = url ? mxcToTrukiMediaUrl(url) : undefined;
  const msgtype = type === 'm.sticker' ? 'm.image' : str(content.msgtype);
  switch (msgtype) {
    case 'm.text':
    case 'm.notice':
    case 'm.emote': {
      const formattedBody = str(content.formatted_body);
      const format = str(content.format);
      return {
        kind: 'text',
        body,
        ...(formattedBody ? { formattedBody } : {}),
        ...(format ? { format } : {}),
      };
    }
    case 'm.image':
    case 'm.video': {
      const width = num(info.w);
      const height = num(info.h);
      return {
        kind: msgtype === 'm.image' ? 'image' : 'video',
        body,
        ...(mediaUrl ? { url: mediaUrl } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      };
    }
    case 'm.file':
    case 'm.audio': {
      const size = num(info.size);
      return {
        kind: 'file',
        name: str(content.filename) || body,
        ...(size !== undefined ? { size } : {}),
        ...(url && mediaUrl ? { mxc: url } : {}),
      };
    }
    default:
      return body ? { kind: 'text', body } : { kind: 'unsupported' };
  }
}

function replyTargetOf(content: unknown): string | undefined {
  if (!isRecord(content)) {
    return undefined;
  }
  const relatesTo = content['m.relates_to'];
  if (!isRecord(relatesTo)) {
    return undefined;
  }
  const inReplyTo = relatesTo['m.in_reply_to'];
  return isRecord(inReplyTo) ? str(inReplyTo.event_id) : undefined;
}

function reactionKeyOf(event: TrukiBridgedEvent): string | undefined {
  if (!isRecord(event.content)) {
    return undefined;
  }
  const relatesTo = event.content['m.relates_to'];
  return isRecord(relatesTo) ? str(relatesTo.key) : undefined;
}

// `events` are one chat's events in stream order (as the duck keeps them).
export function buildTrukiTimeline(
  events: ReadonlyArray<TrukiBridgedEvent>,
  localUserId: string
): ReadonlyArray<TrukiTimelineItem> {
  const byId = new Map<string, TrukiBridgedEvent>();
  // The latest edit of each message; later stream order wins.
  const latestEdit = new Map<string, TrukiBridgedEvent>();
  const reactionsByTarget = new Map<
    string,
    Map<string, { senders: Set<string>; myEventId?: string; mine: boolean }>
  >();

  for (const event of events) {
    byId.set(event.id, event);
  }

  for (const event of events) {
    if (event.redacted || !event.relatesTo) {
      continue;
    }
    if (event.relType === 'm.replace') {
      const target = byId.get(event.relatesTo);
      const previous = latestEdit.get(event.relatesTo);
      if (
        target &&
        target.sender === event.sender &&
        (!previous || previous.streamOrder < event.streamOrder)
      ) {
        latestEdit.set(event.relatesTo, event);
      }
    } else if (
      event.type === 'm.reaction' &&
      event.relType === 'm.annotation' &&
      event.status !== 'failed'
    ) {
      const key = reactionKeyOf(event);
      if (!key) {
        continue;
      }
      let byKey = reactionsByTarget.get(event.relatesTo);
      if (!byKey) {
        byKey = new Map();
        reactionsByTarget.set(event.relatesTo, byKey);
      }
      const entry = byKey.get(key) ?? { senders: new Set(), mine: false };
      entry.senders.add(event.sender);
      if (isTrukiOutgoingEvent(event, localUserId)) {
        entry.mine = true;
        if (event.status !== 'pending') {
          entry.myEventId = event.id;
        }
      }
      byKey.set(key, entry);
    }
  }

  function displayedContent(event: TrukiBridgedEvent): {
    content: TrukiTimelineContent;
    edited: boolean;
  } {
    const edit = latestEdit.get(event.id);
    const newContent =
      edit && isRecord(edit.content)
        ? edit.content['m.new_content']
        : undefined;
    if (!event.redacted && edit && isRecord(newContent)) {
      return {
        content: parseTrukiTimelineContent(event.type, newContent),
        edited: true,
      };
    }
    return {
      content: parseTrukiTimelineContent(event.type, event.content),
      edited: false,
    };
  }

  const items: Array<TrukiTimelineItem> = [];
  for (const event of events) {
    if (!isTimelineMessage(event)) {
      continue;
    }
    const { content, edited } = displayedContent(event);

    let replyTo: TrukiTimelineQuote | undefined;
    const replyId = event.redacted ? undefined : replyTargetOf(event.content);
    if (replyId) {
      const target = byId.get(replyId);
      replyTo = target
        ? {
            id: replyId,
            found: true,
            outgoing: isTrukiOutgoingEvent(target, localUserId),
            redacted: target.redacted,
            content: displayedContent(target).content,
          }
        : { id: replyId, found: false, outgoing: false, redacted: false };
    }

    const reactions: Array<TrukiTimelineReaction> = [];
    if (!event.redacted) {
      for (const [key, entry] of reactionsByTarget.get(event.id) ?? []) {
        reactions.push({
          key,
          count: entry.senders.size,
          mine: entry.mine,
          ...(entry.myEventId ? { myEventId: entry.myEventId } : {}),
        });
      }
    }

    items.push({
      id: event.id,
      sender: event.sender,
      outgoing: isTrukiOutgoingEvent(event, localUserId),
      timestamp: event.timestamp,
      status: event.status,
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      redacted: event.redacted,
      edited: edited && !event.redacted,
      content: event.redacted ? { kind: 'unsupported' } : content,
      ...(replyTo ? { replyTo } : {}),
      reactions,
    });
  }
  return items;
}

export type TrukiConversationBannerKind =
  | 'bridge-starting'
  | 'bridge-down'
  | 'logged-out';

// Account states in which the account has to be logged in again.
const LOGGED_OUT_STATES: ReadonlySet<string> = new Set([
  'LOGGED_OUT',
  'BAD_CREDENTIALS',
]);

export function getTrukiConversationBanner(
  bridgeState: TrukiSupervisorStateName,
  accountState: string | undefined
): TrukiConversationBannerKind | undefined {
  if (bridgeState === 'starting') {
    return 'bridge-starting';
  }
  if (bridgeState !== 'running') {
    return 'bridge-down';
  }
  if (accountState !== undefined && LOGGED_OUT_STATES.has(accountState)) {
    return 'logged-out';
  }
  return undefined;
}

// A display name for a network id when networks.list has not named it.
export function getTrukiNetworkDisplayName(
  network: string,
  networks: ReadonlyArray<{ id: string; name: string }>
): string {
  const named = networks.find(n => n.id === network)?.name;
  if (named) {
    return named;
  }
  switch (network) {
    case 'whatsapp':
      return 'WhatsApp';
    case 'meta':
    case 'facebook':
    case 'messenger':
      return 'Messenger';
    case 'instagram':
      return 'Instagram';
    default:
      return network;
  }
}
