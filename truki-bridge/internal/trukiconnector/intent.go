// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package trukiconnector

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// intent is a bridgev2.MatrixAPI acting as one local MXID: a ghost, the
// bridge bot or the local user's double puppet.
type intent struct {
	c            *Connector
	mxid         id.UserID
	doublePuppet bool
}

var _ bridgev2.MatrixAPI = (*intent)(nil)

func (i *intent) GetMXID() id.UserID   { return i.mxid }
func (i *intent) IsDoublePuppet() bool { return i.doublePuppet }

// relationFields picks the relation out of stored Matrix content.
type relationFields struct {
	RelatesTo *struct {
		EventID   id.EventID `json:"event_id"`
		RelType   string     `json:"rel_type"`
		InReplyTo *struct {
			EventID id.EventID `json:"event_id"`
		} `json:"m.in_reply_to"`
	} `json:"m.relates_to"`
	Redacts id.EventID `json:"redacts"`
}

// newRow builds a store row. A reply with no other relation is recorded
// with RelType "m.in_reply_to", the key Matrix uses for it.
func newRow(room id.RoomID, evID id.EventID, sender id.UserID, evtType event.Type, stateKey *string, content *event.Content, ts time.Time) (*store.Event, error) {
	raw, err := json.Marshal(content)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal %s content: %w", evtType.Type, err)
	}
	if ts.IsZero() {
		ts = time.Now()
	}
	row := &store.Event{
		ID: evID, RoomID: room, Sender: sender, Type: evtType.Type,
		StateKey: stateKey, Content: raw, Timestamp: ts,
	}
	var rel relationFields
	if json.Unmarshal(raw, &rel) == nil && rel.RelatesTo != nil {
		switch {
		case rel.RelatesTo.EventID != "":
			row.RelatesTo, row.RelType = rel.RelatesTo.EventID, rel.RelatesTo.RelType
		case rel.RelatesTo.InReplyTo != nil && rel.RelatesTo.InReplyTo.EventID != "":
			row.RelatesTo, row.RelType = rel.RelatesTo.InReplyTo.EventID, "m.in_reply_to"
		}
	}
	return row, nil
}

// eventRow converts a batch-send event to a store row.
func eventRow(room id.RoomID, evt *event.Event) (*store.Event, error) {
	evID := evt.ID
	if evID == "" {
		evID = newEventID()
	}
	var ts time.Time
	if evt.Timestamp != 0 {
		ts = time.UnixMilli(evt.Timestamp)
	}
	return newRow(room, evID, evt.Sender, evt.Type, evt.StateKey, &evt.Content, ts)
}

// isTimelineMessage reports whether ev counts towards a chat's last
// activity and unread count: a message or sticker that is not an edit.
func isTimelineMessage(ev *store.Event) bool {
	return ev.StateKey == nil && ev.RelType != string(event.RelReplace) &&
		(ev.Type == event.EventMessage.Type || ev.Type == event.EventSticker.Type)
}

// applyMessage updates chat for a newly stored event. When countUnread is
// set, a message from someone else increments the unread count and one from
// the local user (sent on another device) clears it, as on a homeserver.
func applyMessage(chat *store.Chat, ev *store.Event, countUnread bool) bool {
	if !isTimelineMessage(ev) {
		return false
	}
	changed := false
	if chat.LastActivity.IsZero() || !ev.Timestamp.Before(chat.LastActivity) {
		chat.LastActivity, chat.LastEventID = ev.Timestamp, ev.ID
		changed = true
	}
	if countUnread {
		if ev.Sender == LocalUser {
			changed = changed || chat.UnreadCount != 0
			chat.UnreadCount = 0
		} else {
			chat.UnreadCount++
			changed = true
		}
	}
	return changed
}

// decodeContent returns content as *T, using Parsed when it already is one.
func decodeContent[T any](content *event.Content) (*T, error) {
	if parsed, ok := content.Parsed.(*T); ok {
		return parsed, nil
	}
	raw, err := json.Marshal(content)
	if err != nil {
		return nil, err
	}
	out := new(T)
	return out, json.Unmarshal(raw, out)
}

// fillProfile fills an empty displayname/avatar from the user's existing
// membership, or from bridgev2's ghost row, as upstream's fillMemberEvent
// does. It reports whether it changed anything.
func (c *Connector) fillProfile(ctx context.Context, room id.RoomID, user id.UserID, m *event.MemberEventContent) bool {
	if m.Displayname != "" || m.AvatarURL != "" {
		return false
	}
	if old, err := c.store.GetMember(ctx, room, user); err == nil && old != nil && (old.Displayname != "" || old.AvatarURL != "") {
		m.Displayname, m.AvatarURL = old.Displayname, old.AvatarURL
		return true
	}
	if c.bridge == nil {
		return false
	}
	if ghost, err := c.bridge.GetGhostByMXID(ctx, user); err == nil && ghost != nil && (ghost.Name != "" || ghost.AvatarMXC != "") {
		m.Displayname, m.AvatarURL = ghost.Name, ghost.AvatarMXC
		return true
	}
	return false
}

// putMembership stores membership for user, keeping a known profile.
func (c *Connector) putMembership(ctx context.Context, room id.RoomID, user id.UserID, membership event.Membership) error {
	m := &event.MemberEventContent{Membership: membership}
	c.fillProfile(ctx, room, user, m)
	return c.store.PutMember(ctx, room, user, m)
}

// storeAndPush inserts row and, when it is new, pushes the stored row (with
// its assigned stream order). It reports whether the row was new.
func (c *Connector) storeAndPush(ctx context.Context, row *store.Event) (*store.Event, bool, error) {
	inserted, err := c.store.PutEvent(ctx, row)
	if err != nil || !inserted {
		return nil, false, err
	}
	stored, err := c.store.GetEvent(ctx, row.ID)
	if err != nil {
		return nil, true, err
	}
	if stored == nil {
		stored = row
	}
	c.sink.Message(stored)
	return stored, true, nil
}

// markRedacted flags the target of a redaction and pushes it again.
func (c *Connector) markRedacted(ctx context.Context, room id.RoomID, target id.EventID) error {
	ev, err := c.store.GetEvent(ctx, target)
	if err != nil || ev == nil || ev.RoomID != room || ev.Redacted {
		return err
	}
	ev.Redacted = true
	if _, err := c.store.PutEvent(ctx, ev); err != nil {
		return err
	}
	c.sink.Message(ev)
	return nil
}

func (i *intent) SendMessage(ctx context.Context, room id.RoomID, evtType event.Type, content *event.Content, extra *bridgev2.MatrixSendExtra) (*mautrix.RespSendEvent, error) {
	if extra == nil {
		extra = &bridgev2.MatrixSendExtra{}
	}
	var evID id.EventID
	switch meta := extra.MessageMeta; {
	case extra.TransactionID != "":
		evID = txnEventID(room, i.mxid, extra.TransactionID)
	case meta != nil && meta.MXID == "":
		// A new remote message part: bridgev2 saves its message row only
		// after this returns, so a crash in between replays the message.
		// The deterministic ID makes that replay a no-op in the store.
		evID = i.c.GenerateDeterministicEventID(room, meta.Room, meta.ID, meta.PartID)
	default:
		evID = newEventID()
	}
	row, err := newRow(room, evID, i.mxid, evtType, nil, content, extra.Timestamp)
	if err != nil {
		return nil, err
	}
	stored, inserted, err := i.c.storeAndPush(ctx, row)
	if err != nil || !inserted {
		return &mautrix.RespSendEvent{EventID: evID}, err
	}
	if evtType == event.EventRedaction {
		var rel relationFields
		if json.Unmarshal(row.Content, &rel) == nil && rel.Redacts != "" {
			if err := i.c.markRedacted(ctx, room, rel.Redacts); err != nil {
				return nil, err
			}
		}
	}
	err = i.c.pushChatUpdate(ctx, room, func(chat *store.Chat) (bool, error) {
		return applyMessage(chat, stored, true), nil
	})
	return &mautrix.RespSendEvent{EventID: evID}, err
}

func (i *intent) SendState(ctx context.Context, room id.RoomID, evtType event.Type, stateKey string, content *event.Content, ts time.Time) (*mautrix.RespSendEvent, error) {
	var member *event.MemberEventContent
	if evtType == event.StateMember {
		var err error
		if member, err = decodeContent[event.MemberEventContent](content); err != nil {
			return nil, fmt.Errorf("invalid member content: %w", err)
		}
		if i.c.fillProfile(ctx, room, id.UserID(stateKey), member) {
			content.Parsed = member
		}
	}
	row, err := newRow(room, newEventID(), i.mxid, evtType, &stateKey, content, ts)
	if err != nil {
		return nil, err
	}
	if _, err := i.c.store.PutEvent(ctx, row); err != nil {
		return nil, err
	}

	var chatChange func(*store.Chat) bool
	switch evtType {
	case event.StateMember:
		if err := i.c.store.PutMember(ctx, room, id.UserID(stateKey), member); err != nil {
			return nil, err
		}
	case event.StatePowerLevels:
		if pl, err := decodeContent[event.PowerLevelsEventContent](content); err == nil {
			i.c.setPowerLevels(room, pl)
		}
	case event.StateRoomName:
		if v, err := decodeContent[event.RoomNameEventContent](content); err == nil {
			chatChange = func(c *store.Chat) bool { c.Name = v.Name; return true }
		}
	case event.StateTopic:
		if v, err := decodeContent[event.TopicEventContent](content); err == nil {
			chatChange = func(c *store.Chat) bool { c.Topic = v.Topic; return true }
		}
	case event.StateRoomAvatar:
		if v, err := decodeContent[event.RoomAvatarEventContent](content); err == nil {
			chatChange = func(c *store.Chat) bool { c.AvatarMXC = v.URL; return true }
		}
	}
	// Every state change is pushed as event.chat (spec §4.2), so Truki can
	// refresh names, avatars and member lists.
	chat, err := i.c.updateChat(ctx, room, func(c *store.Chat) (bool, error) {
		return chatChange != nil && chatChange(c), nil
	})
	if err == nil && chat == nil {
		chat, err = i.c.store.GetChat(ctx, room)
	}
	if err != nil {
		return nil, err
	}
	if chat != nil {
		i.c.sink.Chat(chat)
	}
	return &mautrix.RespSendEvent{EventID: row.ID}, nil
}

// unreadAfter counts messages from others newer than target.
func (c *Connector) unreadAfter(ctx context.Context, room id.RoomID, target id.EventID) (int, error) {
	t, err := c.store.GetEvent(ctx, target)
	if err != nil || t == nil || t.RoomID != room {
		return 0, err
	}
	const page = 100
	count := 0
	var before int64
	for {
		events, err := c.store.ListEvents(ctx, room, before, page)
		if err != nil {
			return 0, err
		}
		for _, ev := range events {
			if ev.StreamOrder <= t.StreamOrder {
				return count, nil
			}
			if isTimelineMessage(ev) && ev.Sender != LocalUser {
				count++
			}
		}
		if len(events) < page {
			return count, nil
		}
		before = events[len(events)-1].StreamOrder
	}
}

// MarkRead by the local user updates the chat's unread count; by anyone
// else it is a read receipt for Truki to show.
func (i *intent) MarkRead(ctx context.Context, room id.RoomID, eventID id.EventID, _ time.Time) error {
	if i.mxid != LocalUser {
		i.c.sink.Receipt(room, i.mxid, eventID)
		return nil
	}
	return i.c.pushChatUpdate(ctx, room, func(chat *store.Chat) (bool, error) {
		unread, err := i.c.unreadAfter(ctx, room, eventID)
		if err != nil || unread == chat.UnreadCount {
			return false, err
		}
		chat.UnreadCount = unread
		return true, nil
	})
}

// MarkUnread has no marked-unread flag to set in the store, so it is
// approximated with the unread count: unread forces it to at least 1, read
// clears it.
func (i *intent) MarkUnread(ctx context.Context, room id.RoomID, unread bool) error {
	return i.c.pushChatUpdate(ctx, room, func(chat *store.Chat) (bool, error) {
		switch {
		case unread && chat.UnreadCount == 0:
			chat.UnreadCount = 1
		case !unread && chat.UnreadCount != 0:
			chat.UnreadCount = 0
		default:
			return false, nil
		}
		return true, nil
	})
}

// MarkTyping pushes the room's current typists. Like upstream, only text
// typing is bridged and the local user's own typing is not echoed.
func (i *intent) MarkTyping(_ context.Context, room id.RoomID, typingType bridgev2.TypingType, timeout time.Duration) error {
	if i.mxid == LocalUser || typingType != bridgev2.TypingTypeText {
		return nil
	}
	i.c.sink.Typing(room, i.c.setTyping(room, i.mxid, timeout > 0))
	return nil
}

func (i *intent) MuteRoom(ctx context.Context, room id.RoomID, until time.Time) error {
	if until.Before(time.Now()) {
		until = time.Time{}
	}
	return i.c.pushChatUpdate(ctx, room, func(chat *store.Chat) (bool, error) {
		if chat.MutedUntil.UnixMilli() == until.UnixMilli() {
			return false, nil
		}
		chat.MutedUntil = until
		return true, nil
	})
}

// Profiles live in bridgev2's ghost table; there is no profile server.
func (i *intent) SetDisplayName(context.Context, string) error            { return nil }
func (i *intent) SetAvatarURL(context.Context, id.ContentURIString) error { return nil }
func (i *intent) SetExtraProfileMeta(context.Context, any) error          { return nil }
func (i *intent) SetProfile(context.Context, any) error                   { return nil }

// TagRoom is a no-op: the chat table has no tag column.
func (i *intent) TagRoom(context.Context, id.RoomID, event.RoomTag, bool) error { return nil }

// DeleteRoom is a no-op: the store has no delete, and keeping local
// history when a portal is cleaned up is the safer default.
func (i *intent) DeleteRoom(context.Context, id.RoomID, bool) error { return nil }

func (i *intent) EnsureJoined(ctx context.Context, room id.RoomID, _ ...bridgev2.EnsureJoinedParams) error {
	m, err := i.c.store.GetMember(ctx, room, i.mxid)
	if err != nil || (m != nil && m.Membership == event.MembershipJoin) {
		return err
	}
	return i.c.putMembership(ctx, room, i.mxid, event.MembershipJoin)
}

func (i *intent) EnsureInvited(ctx context.Context, room id.RoomID, user id.UserID) error {
	m, err := i.c.store.GetMember(ctx, room, user)
	if err != nil || (m != nil && (m.Membership == event.MembershipJoin || m.Membership == event.MembershipInvite)) {
		return err
	}
	return i.c.putMembership(ctx, room, user, event.MembershipInvite)
}

// portalLogin returns the lowest-sorting login in a portal that has no
// receiver (not split per login). bridgev2 records the source login in the
// portal (user_portal) before it creates the room, so this finds the login
// whose event created the chat. It returns "" without a bridge (unit tests).
func (c *Connector) portalLogin(ctx context.Context, key networkid.PortalKey) (string, error) {
	if c.bridge == nil {
		return "", nil
	}
	logins, err := c.bridge.GetUserLoginsInPortal(ctx, key)
	if err != nil {
		return "", fmt.Errorf("failed to get logins in portal %s: %w", key.ID, err)
	}
	best := ""
	for _, ul := range logins {
		if best == "" || string(ul.ID) < best {
			best = string(ul.ID)
		}
	}
	return best, nil
}

// CreateRoom inserts a chat row (spaces get none: they are not chats) and
// the initial members, all joined because AutoJoinInvites is advertised.
// The room ID is the request's BeeperLocalRoomID when set, so portals get
// their deterministic ID; creating an existing room returns it unchanged.
// LoginID is the bridge info's receiver, or for a portal without one the
// login that is in the portal (see portalLogin).
func (i *intent) CreateRoom(ctx context.Context, req *mautrix.ReqCreateRoom) (id.RoomID, error) {
	room := req.BeeperLocalRoomID
	if room == "" {
		room = newRoomID()
	}
	if existing, err := i.c.store.GetChat(ctx, room); err != nil || existing != nil {
		return room, err
	}
	pl := req.PowerLevelOverride
	if pl == nil {
		pl = defaultPowerLevels()
	}
	chat := &store.Chat{ID: room, Network: i.c.network, Name: req.Name, Topic: req.Topic, IsDM: req.IsDirect}
	for _, evt := range req.InitialState {
		switch evt.Type {
		case event.StateRoomName:
			if v, err := decodeContent[event.RoomNameEventContent](&evt.Content); err == nil {
				chat.Name = v.Name
			}
		case event.StateTopic:
			if v, err := decodeContent[event.TopicEventContent](&evt.Content); err == nil {
				chat.Topic = v.Topic
			}
		case event.StateRoomAvatar:
			if v, err := decodeContent[event.RoomAvatarEventContent](&evt.Content); err == nil {
				chat.AvatarMXC = v.URL
			}
		case event.StateBridge:
			if v, err := decodeContent[event.BridgeEventContent](&evt.Content); err == nil {
				chat.PortalID, chat.LoginID = v.Channel.ID, v.Channel.Receiver
			}
		case event.StatePowerLevels:
			if v, err := decodeContent[event.PowerLevelsEventContent](&evt.Content); err == nil {
				pl = v
			}
		}
	}
	if chat.LoginID == "" && chat.PortalID != "" {
		login, err := i.c.portalLogin(ctx, networkid.PortalKey{ID: networkid.PortalID(chat.PortalID)})
		if err != nil {
			return "", err
		}
		chat.LoginID = login
	}
	i.c.setPowerLevels(room, pl)

	members := append([]id.UserID{i.mxid}, req.BeeperInitialMembers...)
	members = append(members, req.Invite...)
	for _, user := range members {
		if err := i.c.putMembership(ctx, room, user, event.MembershipJoin); err != nil {
			return "", err
		}
	}
	if fmt.Sprint(req.CreationContent["type"]) == string(event.RoomTypeSpace) {
		return room, nil
	}
	if err := i.c.store.PutChat(ctx, chat); err != nil {
		return "", err
	}
	i.c.sink.Chat(chat)
	return room, nil
}

func (i *intent) GetEvent(ctx context.Context, room id.RoomID, eventID id.EventID) (*event.Event, error) {
	row, err := i.c.store.GetEvent(ctx, eventID)
	if err != nil {
		return nil, err
	}
	if row == nil || row.RoomID != room {
		return nil, mautrix.MNotFound.WithMessage("event %s not found in %s", eventID, room)
	}
	class := event.MessageEventType
	if row.StateKey != nil {
		class = event.StateEventType
	}
	evt := &event.Event{
		ID:        row.ID,
		RoomID:    row.RoomID,
		Sender:    row.Sender,
		Type:      event.Type{Type: row.Type, Class: class},
		StateKey:  row.StateKey,
		Timestamp: row.Timestamp.UnixMilli(),
	}
	if err := json.Unmarshal(row.Content, &evt.Content); err != nil {
		return nil, fmt.Errorf("stored content of %s is invalid: %w", eventID, err)
	}
	// Like upstream, an unparseable content is not an error: Raw stays usable.
	_ = evt.Content.ParseRaw(evt.Type)
	return evt, nil
}
