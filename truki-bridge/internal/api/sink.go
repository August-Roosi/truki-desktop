// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"time"
	"unicode/utf8"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/trukiconnector"
)

// Sink forwards every change the connector reports to Truki as an RPC
// notification. The host wraps it with its state tracker; Truki receives
// the notifications on the same connection as the replies.
type Sink struct {
	notify func(method string, params any)
	st     *store.Store
}

// NewSink returns a Sink pushing notifications through notify, the RPC
// connection's Notify. st is read for each chat's lastMessage; with a nil st
// event.chat carries none.
func NewSink(notify func(method string, params any), st *store.Store) *Sink {
	return &Sink{notify: notify, st: st}
}

// Message pushes event.message for a stored or updated event.
func (s *Sink) Message(ev *store.Event) { s.notify("event.message", newEventOut(ev)) }

// Chat pushes event.chat for a changed chat row.
func (s *Sink) Chat(c *store.Chat) {
	s.notify("event.chat", newChatOutWith(context.Background(), s.st, c))
}

// AccountState pushes event.accountState for a login's bridge state.
func (s *Sink) AccountState(network string, st status.BridgeState) {
	p := map[string]any{
		"network": network,
		"loginId": string(st.RemoteID),
		"state":   string(st.StateEvent),
	}
	if reason := accountStateReason(st); reason != "" {
		p["reason"] = reason
	}
	s.notify("event.accountState", p)
}

// accountStateReason is the BridgeState's error code and message joined,
// "" when it has neither. Nothing else of the state goes in: Info can carry
// network-specific details the user never needs to see.
func accountStateReason(st status.BridgeState) string {
	switch {
	case st.Error != "" && st.Message != "":
		return string(st.Error) + ": " + st.Message
	case st.Error != "":
		return string(st.Error)
	default:
		return st.Message
	}
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
	// LastMessage is the chat's last timeline message (the lastEventId
	// event), absent when the chat has none.
	LastMessage *lastMessageOut `json:"lastMessage,omitempty"`
}

// lastMessageOut is the chat-list preview of a chat's last message.
type lastMessageOut struct {
	Body     string `json:"body"`
	FromMe   bool   `json:"fromMe"`
	Redacted bool   `json:"redacted,omitempty"`
}

// lastMessageMaxRunes caps the preview body: the chat list shows one line.
const lastMessageMaxRunes = 200

// newChatOutWith is newChatOut plus the chat's lastMessage, read from st.
// A nil st, a missing event or a read error leave lastMessage out: the
// preview is a nicety and never fails the chat itself.
func newChatOutWith(ctx context.Context, st *store.Store, c *store.Chat) chatOut {
	out := newChatOut(c)
	if st == nil || c.LastEventID == "" {
		return out
	}
	ev, err := st.GetEvent(ctx, c.LastEventID)
	if err != nil || ev == nil {
		return out
	}
	out.LastMessage = newLastMessageOut(ev)
	return out
}

func newLastMessageOut(ev *store.Event) *lastMessageOut {
	lm := &lastMessageOut{FromMe: ev.Sender == trukiconnector.LocalUser}
	if ev.Redacted {
		lm.Redacted = true
		return lm
	}
	var content struct {
		Body string `json:"body"`
	}
	if json.Unmarshal(ev.Content, &content) == nil {
		lm.Body = truncateRunes(content.Body, lastMessageMaxRunes)
	}
	return lm
}

// truncateRunes cuts s to at most n runes, never splitting a character.
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i := 0
	for pos := range s {
		if i == n {
			return s[:pos]
		}
		i++
	}
	return s
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
