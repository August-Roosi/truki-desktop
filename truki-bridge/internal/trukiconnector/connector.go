// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Package trukiconnector is the "Matrix half" of truki-bridge: a
// bridgev2.MatrixConnector that keeps rooms, events and members in Truki's
// local store instead of on a homeserver, and pushes changes to a Sink.
package trukiconnector

import (
	"context"
	"slices"
	"sync"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// Sink receives every change the connector makes, for forwarding to Truki
// as RPC notifications.
type Sink interface {
	Message(ev *store.Event)                            // → event.message
	Chat(c *store.Chat)                                 // → event.chat
	AccountState(network string, st status.BridgeState) // → event.accountState
	Notify(network string, d *bridgev2.DirectNotificationData)
	Typing(room id.RoomID, users []id.UserID)
	Receipt(room id.RoomID, user id.UserID, ev id.EventID)
}

// Connector implements bridgev2.MatrixConnector for one network.
type Connector struct {
	network  string
	store    *store.Store
	mediaDir string
	sink     Sink

	bridge *bridgev2.Bridge // set by Init; nil in unit tests

	bot   *intent
	local *intent

	// chatMu serialises read-modify-write of chat rows (unread counts).
	chatMu sync.Mutex

	stateMu     sync.Mutex
	powerLevels map[id.RoomID]*event.PowerLevelsEventContent
	typing      map[id.RoomID]map[id.UserID]struct{}
}

var (
	_ bridgev2.MatrixConnector                  = (*Connector)(nil)
	_ bridgev2.MatrixConnectorWithNotifications = (*Connector)(nil)
)

// New returns a connector for network that stores into st, keeps media
// files in mediaDir and reports changes to sink.
func New(network string, st *store.Store, mediaDir string, sink Sink) *Connector {
	c := &Connector{
		network:     network,
		store:       st,
		mediaDir:    mediaDir,
		sink:        sink,
		powerLevels: make(map[id.RoomID]*event.PowerLevelsEventContent),
		typing:      make(map[id.RoomID]map[id.UserID]struct{}),
	}
	c.bot = &intent{c: c, mxid: BotMXID}
	c.local = &intent{c: c, mxid: LocalUser, doublePuppet: true}
	return c
}

func (c *Connector) Init(br *bridgev2.Bridge)    { c.bridge = br }
func (c *Connector) Start(context.Context) error { return nil }
func (c *Connector) PreStop()                    {}
func (c *Connector) Stop()                       {}
func (c *Connector) ServerName() string          { return ServerName }

func (c *Connector) GetCapabilities() *bridgev2.MatrixCapabilities {
	return &bridgev2.MatrixCapabilities{AutoJoinInvites: true, BatchSending: true}
}

func (c *Connector) GhostIntent(userID networkid.UserID) bridgev2.MatrixAPI {
	return &intent{c: c, mxid: c.FormatGhostMXID(userID)}
}

func (c *Connector) BotIntent() bridgev2.MatrixAPI { return c.bot }

// NewUserIntent returns the double-puppet intent for the local user. Any
// other Matrix user has no double puppet (nil intent, no error), matching
// upstream's behaviour when no access token is available.
func (c *Connector) NewUserIntent(_ context.Context, userID id.UserID, accessToken string) (bridgev2.MatrixAPI, string, error) {
	if userID != LocalUser {
		return nil, accessToken, nil
	}
	return c.local, accessToken, nil
}

func (c *Connector) SendBridgeStatus(_ context.Context, state *status.BridgeState) error {
	if state != nil {
		c.sink.AccountState(c.network, *state)
	}
	return nil
}

// messageStatus maps a bridgev2 status to the store's pending|sent|failed.
func messageStatus(s event.MessageStatus) string {
	switch s {
	case event.MessageStatusSuccess:
		return "sent"
	case event.MessageStatusPending:
		return "pending"
	default:
		return "failed"
	}
}

func (c *Connector) SendMessageStatus(ctx context.Context, ms *bridgev2.MessageStatus, info *bridgev2.MessageStatusEventInfo) {
	if ms == nil || info == nil || info.SourceEventID == "" {
		return
	}
	errCode := ""
	if ms.Status != event.MessageStatusSuccess && ms.Status != event.MessageStatusPending {
		errCode = string(ms.ErrorReason)
	}
	if err := c.store.SetEventStatus(ctx, info.SourceEventID, messageStatus(ms.Status), errCode); err != nil {
		zerolog.Ctx(ctx).Err(err).Stringer("event_id", info.SourceEventID).Msg("Failed to store message status")
		return
	}
	ev, err := c.store.GetEvent(ctx, info.SourceEventID)
	if err != nil {
		zerolog.Ctx(ctx).Err(err).Stringer("event_id", info.SourceEventID).Msg("Failed to reload event after status update")
	} else if ev != nil {
		c.sink.Message(ev)
	}
}

func (c *Connector) DisplayNotification(_ context.Context, data *bridgev2.DirectNotificationData) {
	c.sink.Notify(c.network, data)
}

func defaultPowerLevels() *event.PowerLevelsEventContent {
	return &event.PowerLevelsEventContent{Users: map[id.UserID]int{BotMXID: 9001}}
}

func (c *Connector) setPowerLevels(room id.RoomID, pl *event.PowerLevelsEventContent) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	c.powerLevels[room] = pl.Clone()
}

// GetPowerLevels returns the room's last power levels. They are kept in
// memory only; after a restart a room reports the defaults until bridgev2
// sends new ones.
func (c *Connector) GetPowerLevels(_ context.Context, room id.RoomID) (*event.PowerLevelsEventContent, error) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if pl, ok := c.powerLevels[room]; ok {
		return pl.Clone(), nil
	}
	return defaultPowerLevels(), nil
}

func (c *Connector) GetMembers(ctx context.Context, room id.RoomID) (map[id.UserID]*event.MemberEventContent, error) {
	return c.store.GetMembers(ctx, room)
}

func (c *Connector) GetMemberInfo(ctx context.Context, room id.RoomID, user id.UserID) (*event.MemberEventContent, error) {
	return c.store.GetMember(ctx, room, user)
}

// setTyping records user as typing (or not) and returns the room's typists.
func (c *Connector) setTyping(room id.RoomID, user id.UserID, typing bool) []id.UserID {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	set := c.typing[room]
	if typing {
		if set == nil {
			set = make(map[id.UserID]struct{})
			c.typing[room] = set
		}
		set[user] = struct{}{}
	} else {
		delete(set, user)
		if len(set) == 0 {
			delete(c.typing, room)
		}
	}
	users := make([]id.UserID, 0, len(set))
	for u := range set {
		users = append(users, u)
	}
	slices.Sort(users)
	return users
}

// updateChat applies fn to the room's chat row under chatMu and saves it
// when fn reports a change. It returns the saved chat, or nil when the room
// has no chat row or nothing changed.
func (c *Connector) updateChat(ctx context.Context, room id.RoomID, fn func(*store.Chat) (bool, error)) (*store.Chat, error) {
	c.chatMu.Lock()
	defer c.chatMu.Unlock()
	chat, err := c.store.GetChat(ctx, room)
	if err != nil || chat == nil {
		return nil, err
	}
	changed, err := fn(chat)
	if err != nil || !changed {
		return nil, err
	}
	if err := c.store.PutChat(ctx, chat); err != nil {
		return nil, err
	}
	return chat, nil
}

// pushChatUpdate runs updateChat and pushes the chat when it changed.
func (c *Connector) pushChatUpdate(ctx context.Context, room id.RoomID, fn func(*store.Chat) (bool, error)) error {
	chat, err := c.updateChat(ctx, room, fn)
	if chat != nil {
		c.sink.Chat(chat)
	}
	return err
}

// BatchSend stores backfilled events in one transaction and pushes one
// event.chat when anything new was stored.
func (c *Connector) BatchSend(ctx context.Context, room id.RoomID, req *mautrix.ReqBeeperBatchSend, _ []*bridgev2.MatrixSendExtra) (*mautrix.RespBeeperBatchSend, error) {
	resp := &mautrix.RespBeeperBatchSend{EventIDs: make([]id.EventID, len(req.Events))}
	rows := make([]*store.Event, len(req.Events))
	for idx, evt := range req.Events {
		row, err := eventRow(room, evt)
		if err != nil {
			return nil, err
		}
		rows[idx] = row
		resp.EventIDs[idx] = row.ID
	}
	inserted, err := c.storeBatch(ctx, room, req, rows)
	if err != nil {
		return nil, err
	}
	if len(inserted) == 0 {
		return resp, nil
	}
	chat, err := c.updateChat(ctx, room, func(chat *store.Chat) (bool, error) {
		changed := false
		for _, row := range inserted {
			changed = applyMessage(chat, row, req.SendNotification) || changed
		}
		return changed, nil
	})
	if err != nil {
		return nil, err
	}
	if chat == nil {
		chat, err = c.store.GetChat(ctx, room)
		if err != nil {
			return nil, err
		}
	}
	if chat != nil {
		c.sink.Chat(chat)
	}
	return resp, nil
}

// storeBatch writes a batch and returns the rows that were new. bridgev2
// sends batches oldest-first in both directions; a history batch
// (Forward false, unless ForwardIfNoMessages applies to an empty room) goes
// below the room's oldest event so the timeline stays in order.
func (c *Connector) storeBatch(ctx context.Context, room id.RoomID, req *mautrix.ReqBeeperBatchSend, rows []*store.Event) ([]*store.Event, error) {
	backward := !req.Forward
	if backward && req.ForwardIfNoMessages {
		existing, err := c.store.ListEvents(ctx, room, 0, 1)
		if err != nil {
			return nil, err
		}
		backward = len(existing) > 0
	}
	var inserted []*store.Event
	if backward {
		ok, err := c.store.PutEventsBefore(ctx, room, rows)
		if err != nil {
			return nil, err
		}
		for idx, row := range rows {
			if ok[idx] {
				inserted = append(inserted, row)
			}
		}
		return inserted, nil
	}
	err := c.store.DB.DoTxn(ctx, nil, func(ctx context.Context) error {
		inserted = inserted[:0]
		for _, row := range rows {
			ok, err := c.store.PutEvent(ctx, row)
			if err != nil {
				return err
			}
			if ok {
				inserted = append(inserted, row)
			}
		}
		return nil
	})
	return inserted, err
}
