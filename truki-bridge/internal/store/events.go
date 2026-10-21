// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
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

// FirstStreamOrder is the stream order auto-assigned to the first event of an
// empty room. Starting high leaves room below it for backward backfill
// (PutEventsBefore) while every stream order stays positive.
const FirstStreamOrder int64 = 1 << 40

// PutEvent upserts an event by its ID and reports whether a new row was
// inserted (false when the event already existed). If StreamOrder is 0, it is
// assigned as max(stream_order)+1 for the event's room, or FirstStreamOrder
// when the room has no events yet; the assignment happens
// inside the INSERT statement (backed by the unique (room_id, stream_order)
// index), so concurrent writers cannot claim the same order.
//
// Re-putting an existing event never changes its stream_order, never overwrites
// a non-empty status or error_code with an empty one, and never un-redacts it.
// The content of an already redacted event is never replaced, so a replayed
// message cannot bring back the body its redaction removed.
func (s *Store) PutEvent(ctx context.Context, evt *Event) (inserted bool, err error) {
	res, err := s.DB.Exec(ctx, `
		INSERT INTO event (id, room_id, sender, type, state_key, content, timestamp, stream_order, status, error_code, redacted, relates_to, rel_type)
		VALUES ($1, $2, $3, $4, $5, $6, $7,
			CASE WHEN $8 = 0
				THEN (SELECT COALESCE(MAX(stream_order) + 1, $14) FROM event WHERE room_id = $2)
				ELSE $8 END,
			$9, $10, $11, $12, $13)
		ON CONFLICT (id) DO NOTHING
	`, evt.ID, evt.RoomID, evt.Sender, evt.Type,
		evt.StateKey, string(evt.Content), sqlNullInt64(evt.Timestamp), evt.StreamOrder,
		evt.Status, evt.ErrorCode, evt.Redacted, evt.RelatesTo, evt.RelType, FirstStreamOrder)
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
			room_id = $2, sender = $3, type = $4, state_key = $5,
			content = CASE WHEN redacted THEN content ELSE $6 END,
			timestamp = $7,
			status = CASE WHEN $8 = '' THEN status ELSE $8 END,
			error_code = CASE WHEN $9 = '' THEN error_code ELSE $9 END,
			redacted = CASE WHEN $10 THEN 1 ELSE redacted END,
			relates_to = $11, rel_type = $12
		WHERE id = $1
	`, evt.ID, evt.RoomID, evt.Sender, evt.Type,
		evt.StateKey, string(evt.Content), sqlNullInt64(evt.Timestamp),
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

// ErrStreamOrderExhausted is returned by PutEventsBefore when the room has no
// positive stream orders left below its oldest event.
var ErrStreamOrderExhausted = errors.New("no stream orders left below the oldest event")

// PutEventsBefore stores a backward-backfill batch for room in one
// transaction. events are given oldest-first. New rows get stream orders
// directly below the room's current minimum, in the given order; rows whose ID
// already exists are skipped (inserted[i] is false) and keep their
// stream_order. In an empty room the batch is assigned forward from
// FirstStreamOrder, like PutEvent. Each event's RoomID is set to room.
func (s *Store) PutEventsBefore(ctx context.Context, room id.RoomID, events []*Event) (inserted []bool, err error) {
	inserted = make([]bool, len(events))
	err = s.DB.DoTxn(ctx, nil, func(ctx context.Context) error {
		clear(inserted)
		var fresh []int
		for idx, evt := range events {
			evt.RoomID = room
			var exists bool
			err := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM event WHERE id = $1)`, evt.ID).Scan(&exists)
			if err != nil {
				return err
			}
			if !exists && !slices.ContainsFunc(fresh, func(j int) bool { return events[j].ID == evt.ID }) {
				fresh = append(fresh, idx)
			}
		}
		if len(fresh) == 0 {
			return nil
		}
		var minOrder sql.NullInt64
		err := s.DB.QueryRow(ctx, `SELECT MIN(stream_order) FROM event WHERE room_id = $1`, room).Scan(&minOrder)
		if err != nil {
			return err
		}
		n := int64(len(fresh))
		if minOrder.Valid && minOrder.Int64-n < 1 {
			return ErrStreamOrderExhausted
		}
		for k, idx := range fresh {
			row := *events[idx]
			row.StreamOrder = 0 // empty room: forward from FirstStreamOrder
			if minOrder.Valid {
				row.StreamOrder = minOrder.Int64 - n + int64(k)
			}
			ok, err := s.PutEvent(ctx, &row)
			if err != nil {
				return err
			}
			inserted[idx] = ok
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return inserted, nil
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
