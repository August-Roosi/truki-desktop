// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"strings"
)

// ErrBadQuery is returned by Search when the query is not valid FTS5 syntax.
var ErrBadQuery = errors.New("invalid full-text search query")

// Search full-text searches event bodies, most relevant first.
// Redacted events are never returned. Returns ErrBadQuery (rather than a raw
// SQLite error) when the query has invalid FTS5 syntax.
func (s *Store) Search(ctx context.Context, query string, limit int) ([]*Event, error) {
	events, err := s.events.QueryMany(ctx, `
		SELECT `+eventColumnsPrefixed+`
		FROM event e
		JOIN event_fts ON event_fts.rowid = e.rowid
		WHERE event_fts MATCH $1 AND e.redacted = 0
		ORDER BY event_fts.rank
		LIMIT $2
	`, query, limit)
	if err != nil {
		if isFTSSyntaxError(err) {
			return nil, ErrBadQuery
		}
		return nil, err
	}
	return events, nil
}

const eventColumnsPrefixed = `e.id, e.room_id, e.sender, e.type, e.state_key, e.content, e.timestamp, e.stream_order, e.status, e.error_code, e.redacted, e.relates_to, e.rel_type`

// isFTSSyntaxError reports whether err is an FTS5 query syntax error.
func isFTSSyntaxError(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "fts5: syntax error") ||
		strings.Contains(msg, "unterminated string") ||
		strings.Contains(msg, "unterminated parenthesis")
}
