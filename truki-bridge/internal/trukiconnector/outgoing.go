// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package trukiconnector

import (
	"context"
	"crypto/rand"
	"errors"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// CodeRateLimited is the error code stored on an outgoing event the network
// refused with a rate limit. Networks report it as the Matrix error
// M_LIMIT_EXCEEDED (as an error reason or a wrapped mautrix.RespError).
const CodeRateLimited = "RATE_LIMITED"

// errorCode is the error code stored for a failed message status.
func errorCode(ms *bridgev2.MessageStatus) string {
	if string(ms.ErrorReason) == mautrix.MLimitExceeded.ErrCode || errors.Is(ms.InternalError, mautrix.MLimitExceeded) {
		return CodeRateLimited
	}
	return string(ms.ErrorReason)
}

// NewOutgoingEventID returns $truki-<uuid v4>, the ID of an event the local
// user sends.
func NewOutgoingEventID() id.EventID {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return id.EventID("$truki-" + formatUUID(b, 4))
}

// RecordOutgoing stores an event sent by the local user with status
// "pending" and pushes it, before the bridge hands it to the network. The
// final status arrives through SendMessageStatus. The returned row has its
// stream order.
func (c *Connector) RecordOutgoing(ctx context.Context, room id.RoomID, evID id.EventID, evtType event.Type, content *event.Content, ts time.Time) (*store.Event, error) {
	row, err := newRow(room, evID, LocalUser, evtType, nil, content, ts)
	if err != nil {
		return nil, err
	}
	row.Status = "pending"
	stored, _, err := c.storeAndPush(ctx, row)
	if err != nil {
		return nil, err
	}
	if stored == nil {
		stored = row
	}
	err = c.pushChatUpdate(ctx, room, func(chat *store.Chat) (bool, error) {
		return applyMessage(chat, stored, true), nil
	})
	return stored, err
}

// SetMuted sets (or, with the zero time, clears) the chat's mute and pushes
// the chat. It reports whether the chat exists.
func (c *Connector) SetMuted(ctx context.Context, room id.RoomID, until time.Time) (bool, error) {
	chat, err := c.updateChat(ctx, room, func(chat *store.Chat) (bool, error) {
		if chat.MutedUntil.Equal(until) {
			return false, nil
		}
		chat.MutedUntil = until
		return true, nil
	})
	if chat != nil {
		c.sink.Chat(chat)
	}
	return chat != nil, err
}
