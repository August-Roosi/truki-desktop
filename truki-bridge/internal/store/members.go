// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"database/sql"
	"encoding/json"

	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

// PutMember upserts a member's state in a room.
func (s *Store) PutMember(ctx context.Context, room id.RoomID, user id.UserID, content *event.MemberEventContent) error {
	contentBytes, err := json.Marshal(content)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx, `
		INSERT INTO member (room_id, user_id, content)
		VALUES ($1, $2, $3)
		ON CONFLICT (room_id, user_id) DO UPDATE SET content = excluded.content
	`, room, user, string(contentBytes))
	return err
}

// GetMembers retrieves all members for a room.
func (s *Store) GetMembers(ctx context.Context, room id.RoomID) (map[id.UserID]*event.MemberEventContent, error) {
	rows, err := s.DB.Query(ctx, `
		SELECT user_id, content FROM member WHERE room_id = $1
	`, room)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := make(map[id.UserID]*event.MemberEventContent)
	for rows.Next() {
		var userID id.UserID
		var contentBytes []byte
		err = rows.Scan(&userID, &contentBytes)
		if err != nil {
			return nil, err
		}
		var content event.MemberEventContent
		err = json.Unmarshal(contentBytes, &content)
		if err != nil {
			return nil, err
		}
		members[userID] = &content
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}

	return members, nil
}

// GetMember retrieves a single member from a room.
func (s *Store) GetMember(ctx context.Context, room id.RoomID, user id.UserID) (*event.MemberEventContent, error) {
	var contentBytes []byte
	err := s.DB.QueryRow(ctx, `
		SELECT content FROM member WHERE room_id = $1 AND user_id = $2
	`, room, user).Scan(&contentBytes)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	var content event.MemberEventContent
	err = json.Unmarshal(contentBytes, &content)
	if err != nil {
		return nil, err
	}
	return &content, nil
}
