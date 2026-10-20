// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix/id"
)

// Event represents a Matrix event stored in the bridge database.
type Event struct {
	ID          id.EventID
	RoomID      id.RoomID
	Sender      id.UserID
	Type        string
	StateKey    *string
	Content     json.RawMessage
	Timestamp   time.Time
	StreamOrder int64
	Status      string // pending|sent|failed|""
	ErrorCode   string
	Redacted    bool
	RelatesTo   id.EventID
	RelType     string
}

const eventColumns = `id, room_id, sender, type, state_key, content, timestamp, stream_order, status, error_code, redacted, relates_to, rel_type`

// Scan implements dbutil.DataStruct.
func (evt *Event) Scan(row dbutil.Scannable) (*Event, error) {
	var stateKey, relatesTo sql.NullString
	var timestamp sql.NullInt64
	var content []byte
	err := row.Scan(&evt.ID, &evt.RoomID, &evt.Sender, &evt.Type, &stateKey,
		&content, &timestamp, &evt.StreamOrder, &evt.Status, &evt.ErrorCode,
		&evt.Redacted, &relatesTo, &evt.RelType)
	if err != nil {
		return nil, err
	}
	evt.Content = json.RawMessage(content)
	if stateKey.Valid {
		evt.StateKey = &stateKey.String
	}
	evt.Timestamp = timeFromNullInt64(timestamp)
	if relatesTo.Valid {
		evt.RelatesTo = id.EventID(relatesTo.String)
	}
	return evt, nil
}

// PutEvent upserts an event by its ID and reports whether a new row was
// inserted (false when the event already existed). If StreamOrder is 0, it is
// assigned as max(stream_order)+1 for the event's room.
func (s *Store) PutEvent(ctx context.Context, evt *Event) (inserted bool, err error) {
	if evt.StreamOrder == 0 {
		var maxOrder sql.NullInt64
		err = s.DB.QueryRow(ctx, `
			SELECT MAX(stream_order) FROM event WHERE room_id = $1
		`, evt.RoomID).Scan(&maxOrder)
		if err != nil {
			return false, err
		}
		evt.StreamOrder = maxOrder.Int64 + 1
	}

	res, err := s.DB.Exec(ctx, `
		INSERT INTO event (id, room_id, sender, type, state_key, content, timestamp, stream_order, status, error_code, redacted, relates_to, rel_type)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (id) DO NOTHING
	`, evt.ID, evt.RoomID, evt.Sender, evt.Type,
		evt.StateKey, string(evt.Content), sqlNullInt64(evt.Timestamp), evt.StreamOrder,
		evt.Status, evt.ErrorCode, evt.Redacted, evt.RelatesTo, evt.RelType)
	if err != nil {
		return false, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if affected > 0 {
		return true, nil
	}
	_, err = s.DB.Exec(ctx, `
		UPDATE event SET
			room_id = $2, sender = $3, type = $4, state_key = $5, content = $6,
			timestamp = $7, stream_order = $8, status = $9, error_code = $10,
			redacted = $11, relates_to = $12, rel_type = $13
		WHERE id = $1
	`, evt.ID, evt.RoomID, evt.Sender, evt.Type,
		evt.StateKey, string(evt.Content), sqlNullInt64(evt.Timestamp), evt.StreamOrder,
		evt.Status, evt.ErrorCode, evt.Redacted, evt.RelatesTo, evt.RelType)
	return false, err
}

// PutEvents upserts multiple events in a single transaction.
func (s *Store) PutEvents(ctx context.Context, events []*Event) error {
	return s.DB.DoTxn(ctx, nil, func(ctx context.Context) error {
		for _, evt := range events {
			_, err := s.PutEvent(ctx, evt)
			if err != nil {
				return err
			}
		}
		return nil
	})
}

// GetEvent retrieves an event by its EventID.
// Returns nil, nil if the event does not exist.
func (s *Store) GetEvent(ctx context.Context, eventID id.EventID) (*Event, error) {
	return s.events.QueryOne(ctx, `
		SELECT `+eventColumns+` FROM event WHERE id = $1
	`, eventID)
}

// ListEvents retrieves events for a room, newest (highest stream order) first.
// before is the stream order to page from: 0 starts at the newest event, any
// other value returns only events with a lower stream order.
func (s *Store) ListEvents(ctx context.Context, room id.RoomID, before int64, limit int) ([]*Event, error) {
	if before > 0 {
		return s.events.QueryMany(ctx, `
			SELECT `+eventColumns+` FROM event
			WHERE room_id = $1 AND stream_order < $2
			ORDER BY stream_order DESC
			LIMIT $3
		`, room, before, limit)
	}
	return s.events.QueryMany(ctx, `
		SELECT `+eventColumns+` FROM event
		WHERE room_id = $1
		ORDER BY stream_order DESC
		LIMIT $2
	`, room, limit)
}

// SetEventStatus updates the status and error code of an event.
func (s *Store) SetEventStatus(ctx context.Context, eventID id.EventID, status, errCode string) error {
	_, err := s.DB.Exec(ctx, `
		UPDATE event SET status = $1, error_code = $2 WHERE id = $3
	`, status, errCode, eventID)
	return err
}
