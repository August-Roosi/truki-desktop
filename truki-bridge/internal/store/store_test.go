// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func newTestDB(t *testing.T) *Store {
	p := filepath.Join(t.TempDir(), "test.db")
	db, err := Open(p, key(1))
	if err != nil {
		t.Fatalf("failed to open DB: %v", err)
	}
	return New(db)
}

func TestUpgradeIdempotent(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	// Run upgrade first time
	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("first upgrade failed: %v", err)
	}

	// Run upgrade second time - should be idempotent
	err = s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("second upgrade failed: %v", err)
	}

	// Verify tables exist
	tables := []string{"chat", "event", "member", "event_fts"}
	for _, table := range tables {
		exists, err := s.DB.TableExists(ctx, table)
		if err != nil {
			t.Fatalf("failed to check if table %s exists: %v", table, err)
		}
		if !exists {
			t.Fatalf("table %s does not exist after upgrade", table)
		}
	}
}

func TestPutEventDedup(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	// Upgrade first
	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	evt := &Event{
		ID:          id.EventID("test_event_1"),
		RoomID:      id.RoomID("!room:example.com"),
		Sender:      id.UserID("@user:example.com"),
		Type:        "m.room.message",
		Content:     json.RawMessage(`{"body":"test message","msgtype":"m.text"}`),
		Timestamp:   time.Now(),
		StreamOrder: 0, // Will be auto-assigned
	}

	// First insert should succeed
	inserted, err := s.PutEvent(ctx, evt)
	if err != nil {
		t.Fatalf("first PutEvent failed: %v", err)
	}
	if !inserted {
		t.Fatal("first PutEvent should have inserted")
	}

	// Second insert with same ID should not insert
	inserted, err = s.PutEvent(ctx, evt)
	if err != nil {
		t.Fatalf("second PutEvent failed: %v", err)
	}
	if inserted {
		t.Fatal("second PutEvent should not have inserted")
	}

	// Verify only one row exists
	var count int
	err = s.DB.QueryRow(ctx, "SELECT COUNT(*) FROM event WHERE id = $1", evt.ID).Scan(&count)
	if err != nil {
		t.Fatalf("failed to count events: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 event, got %d", count)
	}
}

func TestListEventsPaging(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	room := id.RoomID("!room:example.com")

	// Insert 25 events with stream orders 1..25
	for i := 1; i <= 25; i++ {
		evt := &Event{
			ID:          id.EventID(fmt.Sprintf("event_%d", i)),
			RoomID:      room,
			Sender:      id.UserID("@user:example.com"),
			Type:        "m.room.message",
			Content:     json.RawMessage(fmt.Sprintf(`{"body":"message %d","msgtype":"m.text"}`, i)),
			Timestamp:   time.Now(),
			StreamOrder: int64(i),
		}
		_, err = s.PutEvent(ctx, evt)
		if err != nil {
			t.Fatalf("failed to insert event %d: %v", i, err)
		}
	}

	// ListEvents with before=0, limit=10 should return events 25..16
	events, err := s.ListEvents(ctx, room, 0, 10)
	if err != nil {
		t.Fatalf("ListEvents failed: %v", err)
	}
	if len(events) != 10 {
		t.Fatalf("expected 10 events, got %d", len(events))
	}
	// Check stream orders are 25, 24, ..., 16
	for i, evt := range events {
		expectedOrder := int64(25 - i)
		if evt.StreamOrder != expectedOrder {
			t.Fatalf("event %d: expected stream_order %d, got %d", i, expectedOrder, evt.StreamOrder)
		}
	}

	// ListEvents with before=16, limit=10 should return events 15..6
	events, err = s.ListEvents(ctx, room, 16, 10)
	if err != nil {
		t.Fatalf("ListEvents with before=16 failed: %v", err)
	}
	if len(events) != 10 {
		t.Fatalf("expected 10 events, got %d", len(events))
	}
	// Check stream orders are 15, 14, ..., 6
	for i, evt := range events {
		expectedOrder := int64(15 - i)
		if evt.StreamOrder != expectedOrder {
			t.Fatalf("event %d: expected stream_order %d, got %d", i, expectedOrder, evt.StreamOrder)
		}
	}
}

func TestListChatsOrderAndCursor(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	// Create 3 chats with different last_activity times
	now := time.Now()
	chat1 := &Chat{
		ID:           id.RoomID("!chat1:example.com"),
		Network:      "whatsapp",
		LoginID:      "login1",
		PortalID:     "portal1",
		Name:         "Chat 1",
		LastActivity: now.Add(-2 * time.Hour), // oldest
	}
	chat2 := &Chat{
		ID:           id.RoomID("!chat2:example.com"),
		Network:      "whatsapp",
		LoginID:      "login1",
		PortalID:     "portal2",
		Name:         "Chat 2",
		LastActivity: now.Add(-1 * time.Hour), // middle
	}
	chat3 := &Chat{
		ID:           id.RoomID("!chat3:example.com"),
		Network:      "whatsapp",
		LoginID:      "login1",
		PortalID:     "portal3",
		Name:         "Chat 3",
		LastActivity: now, // newest
	}

	for _, chat := range []*Chat{chat1, chat2, chat3} {
		err = s.PutChat(ctx, chat)
		if err != nil {
			t.Fatalf("failed to put chat: %v", err)
		}
	}

	// List all chats without cursor - should return newest first
	chats, cursor, err := s.ListChats(ctx, "", 10)
	if err != nil {
		t.Fatalf("ListChats failed: %v", err)
	}
	if len(chats) != 3 {
		t.Fatalf("expected 3 chats, got %d", len(chats))
	}

	// Check order: newest first
	if chats[0].ID != chat3.ID {
		t.Fatalf("expected first chat to be %s, got %s", chat3.ID, chats[0].ID)
	}
	if chats[1].ID != chat2.ID {
		t.Fatalf("expected second chat to be %s, got %s", chat2.ID, chats[1].ID)
	}
	if chats[2].ID != chat1.ID {
		t.Fatalf("expected third chat to be %s, got %s", chat1.ID, chats[2].ID)
	}

	// List with limit=2, should get cursor
	chats, cursor, err = s.ListChats(ctx, "", 2)
	if err != nil {
		t.Fatalf("ListChats with limit=2 failed: %v", err)
	}
	if len(chats) != 2 {
		t.Fatalf("expected 2 chats, got %d", len(chats))
	}
	if cursor == "" {
		t.Fatal("expected non-empty cursor")
	}

	// List with cursor, should get remaining chat without overlap
	chats, next, err := s.ListChats(ctx, cursor, 2)
	if err != nil {
		t.Fatalf("ListChats with cursor failed: %v", err)
	}
	if len(chats) != 1 {
		t.Fatalf("expected 1 chat, got %d", len(chats))
	}
	if chats[0].ID != chat1.ID {
		t.Fatalf("expected remaining chat to be %s, got %s", chat1.ID, chats[0].ID)
	}
	if next != "" {
		t.Fatalf("expected empty cursor on last page, got %s", next)
	}

	// The second page must not repeat anything from the first page
	page2, _, err := s.ListChats(ctx, cursor, 2)
	if err != nil {
		t.Fatalf("ListChats with cursor failed: %v", err)
	}
	seen := map[id.RoomID]bool{}
	for _, c := range []*Chat{chat3, chat2} {
		seen[c.ID] = true
	}
	for _, c := range page2 {
		if seen[c.ID] {
			t.Fatalf("chat %s appeared on both pages", c.ID)
		}
	}
}

func TestListChatsZeroLimit(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	// Seed a chat so an accidental query would have something to return.
	now := time.Now()
	err = s.PutChat(ctx, &Chat{
		ID:           id.RoomID("!zero:example.com"),
		Network:      "whatsapp",
		LoginID:      "login1",
		PortalID:     "portal1",
		Name:         "Zero limit chat",
		LastActivity: now,
	})
	if err != nil {
		t.Fatalf("failed to put chat: %v", err)
	}

	for _, limit := range []int{0, -1} {
		chats, next, err := s.ListChats(ctx, "", limit)
		if err != nil {
			t.Fatalf("ListChats with limit=%d failed: %v", limit, err)
		}
		if len(chats) != 0 {
			t.Fatalf("limit=%d: expected 0 chats, got %d", limit, len(chats))
		}
		if next != "" {
			t.Fatalf("limit=%d: expected empty next cursor, got %s", limit, next)
		}
	}

	// A zero limit with a cursor must behave the same, not panic or error.
	chats, next, err := s.ListChats(ctx, encodeChatCursor(0, id.RoomID("!zero:example.com")), 0)
	if err != nil {
		t.Fatalf("ListChats with cursor and limit=0 failed: %v", err)
	}
	if len(chats) != 0 {
		t.Fatalf("cursor + limit=0: expected 0 chats, got %d", len(chats))
	}
	if next != "" {
		t.Fatalf("cursor + limit=0: expected empty next cursor, got %s", next)
	}
}

func TestSearchFTS(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	room := id.RoomID("!room:example.com")

	// Insert event with Estonian text
	evt1 := &Event{
		ID:          id.EventID("evt_estonian"),
		RoomID:      room,
		Sender:      id.UserID("@user1:example.com"),
		Type:        "m.room.message",
		Content:     json.RawMessage(`{"body":"tere hommikust","msgtype":"m.text"}`),
		Timestamp:   time.Now(),
		StreamOrder: 1,
		Redacted:    false,
	}

	// Insert event with English text
	evt2 := &Event{
		ID:          id.EventID("evt_english"),
		RoomID:      room,
		Sender:      id.UserID("@user2:example.com"),
		Type:        "m.room.message",
		Content:     json.RawMessage(`{"body":"good morning 🌅","msgtype":"m.text"}`),
		Timestamp:   time.Now(),
		StreamOrder: 2,
		Redacted:    false,
	}

	for _, evt := range []*Event{evt1, evt2} {
		_, err = s.PutEvent(ctx, evt)
		if err != nil {
			t.Fatalf("failed to insert event: %v", err)
		}
	}

	// Search for Estonian word
	results, err := s.Search(ctx, "hommikust", 10)
	if err != nil {
		t.Fatalf("search for hommikust failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result for hommikust, got %d", len(results))
	}
	if results[0].ID != evt1.ID {
		t.Fatalf("expected result to be evt1, got %s", results[0].ID)
	}

	// Search for English word
	results, err = s.Search(ctx, "morning", 10)
	if err != nil {
		t.Fatalf("search for morning failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result for morning, got %d", len(results))
	}
	if results[0].ID != evt2.ID {
		t.Fatalf("expected result to be evt2, got %s", results[0].ID)
	}

	// Search with bad queries: any FTS5 parse/prepare error must come back as
	// ErrBadQuery (never a raw SQLite error, never a panic).
	for _, bad := range []string{`foo:bar`, `AND`, `*`, `a.b`, `"unbalanced`} {
		_, err = s.Search(ctx, bad, 10)
		if !errors.Is(err, ErrBadQuery) {
			t.Fatalf("expected ErrBadQuery for query %q, got %v", bad, err)
		}
	}

	// A normal query still works after all the bad ones.
	results, err = s.Search(ctx, "hommikust", 10)
	if err != nil {
		t.Fatalf("search for hommikust after bad queries failed: %v", err)
	}
	if len(results) != 1 || results[0].ID != evt1.ID {
		t.Fatalf("expected evt1 for hommikust, got %v", results)
	}
}

func TestRedactedEventLeavesFTS(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	room := id.RoomID("!room:example.com")

	// Insert event
	evt := &Event{
		ID:          id.EventID("evt_searchable"),
		RoomID:      room,
		Sender:      id.UserID("@user:example.com"),
		Type:        "m.room.message",
		Content:     json.RawMessage(`{"body":"find me","msgtype":"m.text"}`),
		Timestamp:   time.Now(),
		StreamOrder: 1,
		Redacted:    false,
	}

	_, err = s.PutEvent(ctx, evt)
	if err != nil {
		t.Fatalf("failed to insert event: %v", err)
	}

	// Verify it's searchable
	results, err := s.Search(ctx, "find", 10)
	if err != nil {
		t.Fatalf("search failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result before redaction, got %d", len(results))
	}

	// Mark as redacted
	_, err = s.DB.Exec(ctx, `
		UPDATE event SET redacted = 1 WHERE id = $1
	`, evt.ID)
	if err != nil {
		t.Fatalf("failed to update event: %v", err)
	}

	// Verify it's no longer searchable
	results, err = s.Search(ctx, "find", 10)
	if err != nil {
		t.Fatalf("search after redaction failed: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected 0 results after redaction, got %d", len(results))
	}
}

func TestPutMember(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	room := id.RoomID("!room:example.com")
	user := id.UserID("@user:example.com")

	content := &event.MemberEventContent{
		Membership:  event.MembershipJoin,
		Displayname: "Test User",
	}

	// Put member
	err = s.PutMember(ctx, room, user, content)
	if err != nil {
		t.Fatalf("PutMember failed: %v", err)
	}

	// Get member
	got, err := s.GetMember(ctx, room, user)
	if err != nil {
		t.Fatalf("GetMember failed: %v", err)
	}
	if got == nil {
		t.Fatal("GetMember returned nil")
	}
	if got.Membership != event.MembershipJoin {
		t.Fatalf("expected membership join, got %s", got.Membership)
	}
	if got.Displayname != "Test User" {
		t.Fatalf("expected displayname 'Test User', got %s", got.Displayname)
	}

	// Get all members
	members, err := s.GetMembers(ctx, room)
	if err != nil {
		t.Fatalf("GetMembers failed: %v", err)
	}
	if len(members) != 1 {
		t.Fatalf("expected 1 member, got %d", len(members))
	}
	if _, exists := members[user]; !exists {
		t.Fatal("expected user in members map")
	}
}

func TestSetEventStatus(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	room := id.RoomID("!room:example.com")
	evt := &Event{
		ID:          id.EventID("evt_status"),
		RoomID:      room,
		Sender:      id.UserID("@user:example.com"),
		Type:        "m.room.message",
		Content:     json.RawMessage(`{"body":"test","msgtype":"m.text"}`),
		Timestamp:   time.Now(),
		StreamOrder: 1,
		Status:      "",
		ErrorCode:   "",
	}

	_, err = s.PutEvent(ctx, evt)
	if err != nil {
		t.Fatalf("PutEvent failed: %v", err)
	}

	// Set status
	err = s.SetEventStatus(ctx, evt.ID, "sent", "")
	if err != nil {
		t.Fatalf("SetEventStatus failed: %v", err)
	}

	// Verify status was set
	got, err := s.GetEvent(ctx, evt.ID)
	if err != nil {
		t.Fatalf("GetEvent failed: %v", err)
	}
	if got.Status != "sent" {
		t.Fatalf("expected status 'sent', got %s", got.Status)
	}
}

func TestListChatsSameActivityPaging(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	// 5 chats sharing the exact same LastActivity.
	activity := time.UnixMilli(1730000000123)
	for i := 1; i <= 5; i++ {
		err = s.PutChat(ctx, &Chat{
			ID:           id.RoomID(fmt.Sprintf("!same%d:example.com", i)),
			Network:      "whatsapp",
			LoginID:      "login1",
			PortalID:     fmt.Sprintf("same-portal-%d", i),
			Name:         fmt.Sprintf("Same %d", i),
			LastActivity: activity,
		})
		if err != nil {
			t.Fatalf("failed to put chat %d: %v", i, err)
		}
	}
	// 2 chats with zero LastActivity; they must be included and page after
	// the chats that do have activity.
	for i := 1; i <= 2; i++ {
		err = s.PutChat(ctx, &Chat{
			ID:       id.RoomID(fmt.Sprintf("!zero%d:example.com", i)),
			Network:  "whatsapp",
			LoginID:  "login1",
			PortalID: fmt.Sprintf("zero-portal-%d", i),
			Name:     fmt.Sprintf("Zero %d", i),
		})
		if err != nil {
			t.Fatalf("failed to put zero-activity chat %d: %v", i, err)
		}
	}

	// Page through everything with limit 2.
	var paged []*Chat
	cursor := ""
	for page := 1; page <= 10; page++ {
		var chats []*Chat
		chats, cursor, err = s.ListChats(ctx, cursor, 2)
		if err != nil {
			t.Fatalf("ListChats page %d failed: %v", page, err)
		}
		paged = append(paged, chats...)
		if cursor == "" {
			break
		}
	}

	// Every chat appears exactly once.
	counts := map[id.RoomID]int{}
	for _, c := range paged {
		counts[c.ID]++
	}
	if len(counts) != 7 {
		t.Fatalf("expected 7 distinct chats, got %d", len(counts))
	}
	for chatID, n := range counts {
		if n != 1 {
			t.Fatalf("chat %s appeared %d times, expected exactly 1", chatID, n)
		}
	}
	// The zero-activity chats sort last, after the ones with activity.
	for i, c := range paged {
		hasActivity := !c.LastActivity.IsZero()
		if i >= 5 && hasActivity {
			t.Fatalf("chat %s has activity but paged after the zero-activity chats", c.ID)
		}
		if i < 5 && !hasActivity {
			t.Fatalf("chat %s has no activity but paged before the chats with activity (position %d)", c.ID, i)
		}
	}
}

func TestPutEventReplayKeepsOrderAndStatus(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	room := id.RoomID("!room:example.com")
	sender := id.UserID("@user:example.com")

	evtA := &Event{
		ID:          id.EventID("replay_a"),
		RoomID:      room,
		Sender:      sender,
		Type:        "m.room.message",
		Content:     json.RawMessage(`{"body":"alpha","msgtype":"m.text"}`),
		Timestamp:   time.Now(),
		StreamOrder: 1,
	}
	evtB := &Event{
		ID:          id.EventID("replay_b"),
		RoomID:      room,
		Sender:      sender,
		Type:        "m.room.message",
		Content:     json.RawMessage(`{"body":"beta","msgtype":"m.text"}`),
		Timestamp:   time.Now(),
		StreamOrder: 2,
	}
	for _, evt := range []*Event{evtA, evtB} {
		if _, err = s.PutEvent(ctx, evt); err != nil {
			t.Fatalf("failed to put event %s: %v", evt.ID, err)
		}
	}

	err = s.SetEventStatus(ctx, evtA.ID, "sent", "")
	if err != nil {
		t.Fatalf("SetEventStatus failed: %v", err)
	}

	// Re-put a FRESH struct for A with StreamOrder 0 and blank status:
	// the stream order and status of the stored event must survive.
	fresh := &Event{
		ID:          evtA.ID,
		RoomID:      room,
		Sender:      sender,
		Type:        "m.room.message",
		Content:     json.RawMessage(`{"body":"alpha replay","msgtype":"m.text"}`),
		Timestamp:   time.Now(),
		StreamOrder: 0,
		Status:      "",
		ErrorCode:   "",
	}
	inserted, err := s.PutEvent(ctx, fresh)
	if err != nil {
		t.Fatalf("re-put failed: %v", err)
	}
	if inserted {
		t.Fatal("re-put of existing event should report inserted=false")
	}

	var count int
	err = s.DB.QueryRow(ctx, "SELECT COUNT(*) FROM event").Scan(&count)
	if err != nil {
		t.Fatalf("failed to count events: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected exactly 2 event rows, got %d", count)
	}

	got, err := s.GetEvent(ctx, evtA.ID)
	if err != nil {
		t.Fatalf("GetEvent failed: %v", err)
	}
	if got.StreamOrder != 1 {
		t.Fatalf("re-put changed stream_order: expected 1, got %d", got.StreamOrder)
	}
	if got.Status != "sent" {
		t.Fatalf("re-put with empty status cleared status: expected 'sent', got %q", got.Status)
	}

	// Re-putting must also never un-redact a redacted event.
	_, err = s.DB.Exec(ctx, "UPDATE event SET redacted = 1 WHERE id = $1", evtA.ID)
	if err != nil {
		t.Fatalf("failed to redact event: %v", err)
	}
	fresh.Redacted = false
	if _, err = s.PutEvent(ctx, fresh); err != nil {
		t.Fatalf("second re-put failed: %v", err)
	}
	got, err = s.GetEvent(ctx, evtA.ID)
	if err != nil {
		t.Fatalf("GetEvent after second re-put failed: %v", err)
	}
	if !got.Redacted {
		t.Fatal("re-put with Redacted=false un-redacted a redacted event")
	}
}

func TestPutEventConcurrentStreamOrder(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	room := id.RoomID("!room:example.com")
	const n = 50

	var wg sync.WaitGroup
	errCh := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			evt := &Event{
				ID:        id.EventID(fmt.Sprintf("race_evt_%d", i)),
				RoomID:    room,
				Sender:    id.UserID("@user:example.com"),
				Type:      "m.room.message",
				Content:   json.RawMessage(fmt.Sprintf(`{"body":"race %d","msgtype":"m.text"}`, i)),
				Timestamp: time.Now(),
			}
			if _, err := s.PutEvent(ctx, evt); err != nil {
				errCh <- err
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	for putErr := range errCh {
		if putErr != nil {
			t.Fatalf("concurrent PutEvent failed: %v", putErr)
		}
	}

	var count, distinct, minOrder, maxOrder int
	err = s.DB.QueryRow(ctx, `
		SELECT COUNT(*), COUNT(DISTINCT stream_order), MIN(stream_order), MAX(stream_order)
		FROM event WHERE room_id = $1
	`, room).Scan(&count, &distinct, &minOrder, &maxOrder)
	if err != nil {
		t.Fatalf("failed to count stream orders: %v", err)
	}
	if count != n || distinct != n {
		t.Fatalf("expected %d events with %d distinct stream orders, got %d/%d", n, n, count, distinct)
	}
	if int64(minOrder) != FirstStreamOrder || int64(maxOrder) != FirstStreamOrder+n-1 {
		t.Fatalf("expected stream orders %d..%d, got min=%d max=%d", FirstStreamOrder, FirstStreamOrder+n-1, minOrder, maxOrder)
	}
}

func TestVacuumKeepsFTSSearch(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	room := id.RoomID("!room:example.com")
	mkEvent := func(eventID, body string, order int64) *Event {
		return &Event{
			ID:          id.EventID(eventID),
			RoomID:      room,
			Sender:      id.UserID("@user:example.com"),
			Type:        "m.room.message",
			Content:     json.RawMessage(fmt.Sprintf(`{"body":%q,"msgtype":"m.text"}`, body)),
			Timestamp:   time.Now(),
			StreamOrder: order,
		}
	}
	for _, evt := range []*Event{
		mkEvent("vacuum_evt_1", "vacuum alpha", 1),
		mkEvent("vacuum_evt_2", "vacuum beta", 2),
		mkEvent("vacuum_evt_3", "vacuum gamma", 3),
	} {
		if _, err = s.PutEvent(ctx, evt); err != nil {
			t.Fatalf("failed to put event: %v", err)
		}
	}

	_, err = s.DB.Exec(ctx, "VACUUM")
	if err != nil {
		t.Fatalf("VACUUM failed: %v", err)
	}

	for _, tc := range []struct {
		query string
		want  id.EventID
	}{
		{"alpha", "vacuum_evt_1"},
		{"beta", "vacuum_evt_2"},
		{"gamma", "vacuum_evt_3"},
	} {
		results, err := s.Search(ctx, tc.query, 10)
		if err != nil {
			t.Fatalf("search for %s after VACUUM failed: %v", tc.query, err)
		}
		if len(results) != 1 || results[0].ID != tc.want {
			t.Fatalf("search for %s after VACUUM: expected [%s], got %v", tc.query, tc.want, results)
		}
	}
}

func TestTimestampMillisecondPrecision(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()

	err := s.Upgrade(ctx)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}

	// A timestamp whose millisecond part is nonzero: second-granularity
	// storage would lose it.
	ts := time.UnixMilli(1730000000123)
	evt := &Event{
		ID:          id.EventID("ms_evt"),
		RoomID:      id.RoomID("!room:example.com"),
		Sender:      id.UserID("@user:example.com"),
		Type:        "m.room.message",
		Content:     json.RawMessage(`{"body":"millis","msgtype":"m.text"}`),
		Timestamp:   ts,
		StreamOrder: 1,
	}
	if _, err = s.PutEvent(ctx, evt); err != nil {
		t.Fatalf("PutEvent failed: %v", err)
	}
	got, err := s.GetEvent(ctx, evt.ID)
	if err != nil {
		t.Fatalf("GetEvent failed: %v", err)
	}
	if got.Timestamp.UnixMilli() != ts.UnixMilli() {
		t.Fatalf("event timestamp lost millisecond precision: expected %d, got %d", ts.UnixMilli(), got.Timestamp.UnixMilli())
	}

	chat := &Chat{
		ID:           id.RoomID("!ms:example.com"),
		Network:      "whatsapp",
		LoginID:      "login1",
		PortalID:     "ms-portal",
		Name:         "Millis",
		LastActivity: ts,
		MutedUntil:   ts.Add(time.Hour),
	}
	if err = s.PutChat(ctx, chat); err != nil {
		t.Fatalf("PutChat failed: %v", err)
	}
	gotChat, err := s.GetChat(ctx, chat.ID)
	if err != nil {
		t.Fatalf("GetChat failed: %v", err)
	}
	if gotChat.LastActivity.UnixMilli() != ts.UnixMilli() {
		t.Fatalf("chat last_activity lost millisecond precision: expected %d, got %d", ts.UnixMilli(), gotChat.LastActivity.UnixMilli())
	}
	if gotChat.MutedUntil.UnixMilli() != ts.Add(time.Hour).UnixMilli() {
		t.Fatalf("chat muted_until lost millisecond precision: expected %d, got %d", ts.Add(time.Hour).UnixMilli(), gotChat.MutedUntil.UnixMilli())
	}
}

func TestPutEventsBefore(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()
	if err := s.Upgrade(ctx); err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}
	mk := func(room id.RoomID, name string) *Event {
		return &Event{
			ID: id.EventID(name), RoomID: room, Sender: "@user:example.com", Type: "m.room.message",
			Content: json.RawMessage(`{"body":"` + name + `"}`), Timestamp: time.Now(),
		}
	}
	order := func(room id.RoomID) []string {
		t.Helper()
		evs, err := s.ListEvents(ctx, room, 0, 100)
		if err != nil {
			t.Fatalf("ListEvents: %v", err)
		}
		var ids []string
		for _, ev := range evs {
			if ev.StreamOrder < 1 {
				t.Fatalf("event %s has non-positive stream order %d", ev.ID, ev.StreamOrder)
			}
			ids = append(ids, string(ev.ID))
		}
		return ids
	}

	// Empty room: assigned forward from FirstStreamOrder.
	empty := id.RoomID("!empty:example.com")
	ins, err := s.PutEventsBefore(ctx, empty, []*Event{mk(empty, "e1"), mk(empty, "e2")})
	if err != nil || !slices.Equal(ins, []bool{true, true}) {
		t.Fatalf("PutEventsBefore(empty) = %v, %v", ins, err)
	}
	if got := order(empty); !slices.Equal(got, []string{"e2", "e1"}) {
		t.Fatalf("empty room order = %v", got)
	}
	if ev, _ := s.GetEvent(ctx, "e1"); ev.StreamOrder != FirstStreamOrder {
		t.Fatalf("e1 stream order = %d; want %d", ev.StreamOrder, FirstStreamOrder)
	}

	// Below existing events, chronological within the batch.
	room := id.RoomID("!room:example.com")
	for _, name := range []string{"live1", "live2"} {
		if _, err := s.PutEvent(ctx, mk(room, name)); err != nil {
			t.Fatal(err)
		}
	}
	ins, err = s.PutEventsBefore(ctx, room, []*Event{mk(room, "old1"), mk(room, "old2"), mk(room, "old3")})
	if err != nil || !slices.Equal(ins, []bool{true, true, true}) {
		t.Fatalf("PutEventsBefore = %v, %v", ins, err)
	}
	if got := order(room); !slices.Equal(got, []string{"live2", "live1", "old3", "old2", "old1"}) {
		t.Fatalf("order = %v", got)
	}

	// Existing IDs are skipped and keep their stream order; new ones go below.
	before, _ := s.GetEvent(ctx, "old1")
	ins, err = s.PutEventsBefore(ctx, room, []*Event{mk(room, "older1"), mk(room, "old1"), mk(room, "older2")})
	if err != nil || !slices.Equal(ins, []bool{true, false, true}) {
		t.Fatalf("PutEventsBefore(replay) = %v, %v", ins, err)
	}
	if after, _ := s.GetEvent(ctx, "old1"); after.StreamOrder != before.StreamOrder {
		t.Fatalf("old1 stream order changed %d -> %d", before.StreamOrder, after.StreamOrder)
	}
	if got := order(room); !slices.Equal(got, []string{"live2", "live1", "old3", "old2", "old1", "older2", "older1"}) {
		t.Fatalf("order after replay = %v", got)
	}

	// A full replay inserts nothing.
	ins, err = s.PutEventsBefore(ctx, room, []*Event{mk(room, "older1"), mk(room, "older2")})
	if err != nil || !slices.Equal(ins, []bool{false, false}) {
		t.Fatalf("PutEventsBefore(full replay) = %v, %v", ins, err)
	}
}
