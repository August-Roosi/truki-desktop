// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"

	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix/id"
)

// Chat represents a chat room/portal in the Truki bridge.
type Chat struct {
	ID           id.RoomID
	Network      string
	LoginID      string
	PortalID     string
	Name         string
	Topic        string
	AvatarMXC    id.ContentURIString
	IsDM         bool
	UnreadCount  int
	MutedUntil   time.Time
	LastActivity time.Time
	LastEventID  id.EventID
}

const chatColumns = `id, network, login_id, portal_id, name, topic, avatar_mxc, is_dm, unread_count, muted_until, last_activity, last_event_id`

// Scan implements dbutil.DataStruct.
func (c *Chat) Scan(row dbutil.Scannable) (*Chat, error) {
	var mutedUntil, lastActivity sql.NullInt64
	err := row.Scan(&c.ID, &c.Network, &c.LoginID, &c.PortalID, &c.Name, &c.Topic,
		&c.AvatarMXC, &c.IsDM, &c.UnreadCount, &mutedUntil, &lastActivity, &c.LastEventID)
	if err != nil {
		return nil, err
	}
	c.MutedUntil = timeFromNullInt64(mutedUntil)
	c.LastActivity = timeFromNullInt64(lastActivity)
	return c, nil
}

// PutChat upserts a chat by its ID.
func (s *Store) PutChat(ctx context.Context, chat *Chat) error {
	return s.chats.Exec(ctx, `
		INSERT INTO chat (id, network, login_id, portal_id, name, topic, avatar_mxc, is_dm, unread_count, muted_until, last_activity, last_event_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		ON CONFLICT (id) DO UPDATE SET
			network = excluded.network,
			login_id = excluded.login_id,
			portal_id = excluded.portal_id,
			name = excluded.name,
			topic = excluded.topic,
			avatar_mxc = excluded.avatar_mxc,
			is_dm = excluded.is_dm,
			unread_count = excluded.unread_count,
			muted_until = excluded.muted_until,
			last_activity = excluded.last_activity,
			last_event_id = excluded.last_event_id
	`, chat.ID, chat.Network, chat.LoginID, chat.PortalID, chat.Name, chat.Topic,
		chat.AvatarMXC, chat.IsDM, chat.UnreadCount,
		sqlNullInt64(chat.MutedUntil), sqlNullInt64(chat.LastActivity), chat.LastEventID)
}

// sqlNullInt64 returns a sql.NullInt64 for a time.Time, NULL for the zero time.
// SQLite stores timestamps as integer milliseconds since the Unix epoch.
func sqlNullInt64(t time.Time) sql.NullInt64 {
	if t.IsZero() {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: t.UnixMilli(), Valid: true}
}

// timeFromNullInt64 converts a sql.NullInt64 (unix milliseconds) to a
// time.Time, zero for NULL.
func timeFromNullInt64(n sql.NullInt64) time.Time {
	if !n.Valid {
		return time.Time{}
	}
	return time.UnixMilli(n.Int64)
}

// chatActivityMillis returns a chat's last activity as unix milliseconds,
// with 0 standing in for a NULL / zero last_activity.
func chatActivityMillis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// cursorSeparator separates the activity and id halves of a chat cursor.
const cursorSeparator = "\x1f"

// ErrBadCursor is returned when a ListChats cursor cannot be decoded.
var ErrBadCursor = errors.New("invalid chat list cursor")

// encodeChatCursor encodes a (last activity millis, chat id) pair as an
// opaque cursor string for ListChats.
func encodeChatCursor(activityMillis int64, chatID id.RoomID) string {
	raw := strconv.FormatInt(activityMillis, 10) + cursorSeparator + string(chatID)
	return base64.URLEncoding.EncodeToString([]byte(raw))
}

// decodeChatCursor decodes an opaque cursor produced by encodeChatCursor.
func decodeChatCursor(cursor string) (activityMillis int64, chatID id.RoomID, err error) {
	raw, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, "", err
	}
	activity, idStr, ok := strings.Cut(string(raw), cursorSeparator)
	if !ok {
		return 0, "", ErrBadCursor
	}
	activityMillis, err = strconv.ParseInt(activity, 10, 64)
	if err != nil {
		return 0, "", ErrBadCursor
	}
	return activityMillis, id.RoomID(idStr), nil
}

// GetChat retrieves a chat by its RoomID.
// Returns nil, nil if the chat does not exist.
func (s *Store) GetChat(ctx context.Context, roomID id.RoomID) (*Chat, error) {
	return s.chats.QueryOne(ctx, `
		SELECT `+chatColumns+` FROM chat WHERE id = $1
	`, roomID)
}

// ListChats retrieves a page of chats ordered by last activity, newest first,
// with the chat id as a tiebreaker. Chats with no last activity sort last.
// The cursor is an opaque string produced by a previous call; an empty cursor
// starts from the newest chat. The returned cursor is empty when there are no
// more chats.
func (s *Store) ListChats(ctx context.Context, cursor string, limit int) ([]*Chat, string, error) {
	var (
		chats []*Chat
		err   error
	)
	if cursor == "" {
		chats, err = s.chats.QueryMany(ctx, `
			SELECT `+chatColumns+` FROM chat
			ORDER BY COALESCE(last_activity, 0) DESC, id DESC
			LIMIT $1
		`, limit)
	} else {
		beforeActivity, beforeID, err := decodeChatCursor(cursor)
		if err != nil {
			return nil, "", err
		}
		chats, err = s.chats.QueryMany(ctx, `
			SELECT `+chatColumns+` FROM chat
			WHERE (COALESCE(last_activity, 0), id) < ($1, $2)
			ORDER BY COALESCE(last_activity, 0) DESC, id DESC
			LIMIT $3
		`, beforeActivity, beforeID, limit)
		if err != nil {
			return nil, "", err
		}
	}
	if err != nil {
		return nil, "", err
	}

	var next string
	if len(chats) == limit {
		last := chats[len(chats)-1]
		next = encodeChatCursor(chatActivityMillis(last.LastActivity), last.ID)
	}
	return chats, next, nil
}
