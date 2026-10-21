// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"

	"github.com/mattn/go-sqlite3"
)

// ErrBadQuery is returned by Search when the query is not valid FTS5 syntax
// (or refers to a column the FTS table does not have).
var ErrBadQuery = errors.New("invalid full-text search query")

// Search full-text searches event bodies, most relevant first.
// Redacted events are never returned. Returns ErrBadQuery (rather than a raw
// SQLite error) when the query cannot be parsed or prepared.
func (s *Store) Search(ctx context.Context, query string, limit int) ([]*Event, error) {
	events, err := s.events.QueryMany(ctx, `
		SELECT `+eventColumnsPrefixed+`
		FROM event e
		JOIN event_fts ON event_fts.rowid = e.rowid_
		WHERE event_fts MATCH $1 AND e.redacted = 0
		ORDER BY event_fts.rank
		LIMIT $2
	`, query, limit)
	if err != nil {
		if isBadQueryError(err) {
			return nil, ErrBadQuery
		}
		return nil, err
	}
	return events, nil
}

const eventColumnsPrefixed = `e.id, e.room_id, e.sender, e.type, e.state_key, e.content, e.timestamp, e.stream_order, e.status, e.error_code, e.redacted, e.relates_to, e.rel_type`

// isBadQueryError reports whether err is an error from preparing or stepping
// the MATCH query itself (SQLITE_ERROR: FTS5 syntax errors, unknown columns,
// and similar), as opposed to I/O, corruption, locking or constraint errors.
func isBadQueryError(err error) bool {
	var sqliteErr sqlite3.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code == sqlite3.ErrError
}
