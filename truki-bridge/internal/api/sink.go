// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// Sink forwards every change the connector reports to Truki as an RPC
// notification. The host wraps it with its state tracker; Truki receives
// the notifications on the same connection as the replies.
type Sink struct {
	notify func(method string, params any)
}

// NewSink returns a Sink pushing notifications through notify, the RPC
// connection's Notify.
func NewSink(notify func(method string, params any)) *Sink {
	return &Sink{notify: notify}
}

// Message pushes event.message for a stored or updated event.
func (s *Sink) Message(ev *store.Event) { s.notify("event.message", newEventOut(ev)) }

// Chat pushes event.chat for a changed chat row.
func (s *Sink) Chat(c *store.Chat) { s.notify("event.chat", newChatOut(c)) }

// AccountState pushes event.accountState for a login's bridge state.
func (s *Sink) AccountState(network string, st status.BridgeState) {
	s.notify("event.accountState", map[string]any{
		"network": network,
		"loginId": string(st.RemoteID),
		"state":   string(st.StateEvent),
	})
}

// Notify pushes event.notify for a network notification.
func (s *Sink) Notify(network string, d *bridgev2.DirectNotificationData) {
	p := map[string]any{"network": network}
	if d != nil {
		if d.Portal != nil {
			p["chatId"] = string(d.Portal.MXID)
		}
		if d.Sender != nil {
			p["senderName"] = d.Sender.Name
		}
		p["messageId"] = string(d.MessageID)
		p["message"] = d.Message
	}
	s.notify("event.notify", p)
}

// Typing pushes event.typing for a chat's typists.
func (s *Sink) Typing(room id.RoomID, users []id.UserID) {
	s.notify("event.typing", map[string]any{"chatId": string(room), "users": users})
}

// Receipt pushes event.receipt for a read receipt.
func (s *Sink) Receipt(room id.RoomID, user id.UserID, ev id.EventID) {
	s.notify("event.receipt", map[string]any{
		"chatId":  string(room),
		"userId":  string(user),
		"eventId": string(ev),
	})
}

// networkOut is one entry of networks.list.
type networkOut struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

// chatOut is a chat on the wire: the params of event.chat, the entries of
// chats.list and the chat of chats.get.
type chatOut struct {
	ID           string `json:"id"`
	Network      string `json:"network"`
	LoginID      string `json:"loginId"`
	Name         string `json:"name"`
	Topic        string `json:"topic"`
	Avatar       string `json:"avatar,omitempty"`
	IsDM         bool   `json:"isDm"`
	UnreadCount  int    `json:"unreadCount"`
	MutedUntil   string `json:"mutedUntil,omitempty"`
	LastActivity string `json:"lastActivity,omitempty"`
	LastEventID  string `json:"lastEventId,omitempty"`
}

func newChatOut(c *store.Chat) chatOut {
	return chatOut{
		ID:           string(c.ID),
		Network:      c.Network,
		LoginID:      c.LoginID,
		Name:         c.Name,
		Topic:        c.Topic,
		Avatar:       string(c.AvatarMXC),
		IsDM:         c.IsDM,
		UnreadCount:  c.UnreadCount,
		MutedUntil:   timeOut(c.MutedUntil),
		LastActivity: timeOut(c.LastActivity),
		LastEventID:  string(c.LastEventID),
	}
}

// eventOut is an event on the wire: the params of event.message, and the
// entries of messages.list and search.
type eventOut struct {
	ID          string          `json:"id"`
	ChatID      string          `json:"chatId"`
	Sender      string          `json:"sender"`
	Type        string          `json:"type"`
	Content     json.RawMessage `json:"content"`
	Timestamp   string          `json:"timestamp,omitempty"`
	StreamOrder int64           `json:"streamOrder"`
	Status      string          `json:"status,omitempty"`
	ErrorCode   string          `json:"errorCode,omitempty"`
	Redacted    bool            `json:"redacted,omitempty"`
	RelatesTo   string          `json:"relatesTo,omitempty"`
	RelType     string          `json:"relType,omitempty"`
}

func newEventOut(ev *store.Event) eventOut {
	return eventOut{
		ID:          string(ev.ID),
		ChatID:      string(ev.RoomID),
		Sender:      string(ev.Sender),
		Type:        ev.Type,
		Content:     ev.Content,
		Timestamp:   timeOut(ev.Timestamp),
		StreamOrder: ev.StreamOrder,
		Status:      ev.Status,
		ErrorCode:   ev.ErrorCode,
		Redacted:    ev.Redacted,
		RelatesTo:   string(ev.RelatesTo),
		RelType:     ev.RelType,
	}
}

func newEventOuts(events []*store.Event) []eventOut {
	out := make([]eventOut, 0, len(events))
	for _, ev := range events {
		out = append(out, newEventOut(ev))
	}
	return out
}

// timeOut renders t as RFC 3339, "" for the zero time.
func timeOut(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}
