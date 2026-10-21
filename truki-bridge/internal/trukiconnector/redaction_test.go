// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package trukiconnector

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// redactEvent sends an m.room.redaction for target through sender.
func redactEvent(t *testing.T, sender bridgev2.MatrixAPI, room id.RoomID, target id.EventID) {
	t.Helper()
	content := &event.Content{Parsed: &event.RedactionEventContent{Redacts: target}}
	if _, err := sender.SendMessage(context.Background(), room, event.EventRedaction, content, nil); err != nil {
		t.Fatalf("SendMessage redaction: %v", err)
	}
}

// findReplacement returns the room's stored m.replace edit of target.
func findReplacement(t *testing.T, st *store.Store, room id.RoomID, target id.EventID) *store.Event {
	t.Helper()
	events, err := st.ListEvents(context.Background(), room, 0, 50)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	for _, ev := range events {
		if ev.RelatesTo == target && ev.RelType == string(event.RelReplace) {
			return ev
		}
	}
	t.Fatalf("no m.replace row for %s", target)
	return nil
}

// Redacting a message also strips the content of its edits, so the edited
// body is gone from the store and the search index, not only the original.
func TestRedactStripsEdits(t *testing.T) {
	c, st, _ := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)

	msg, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("secret words"), nil)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	edit := &event.Content{Parsed: &event.MessageEventContent{
		MsgType:    event.MsgText,
		Body:       "* secret words 2",
		NewContent: &event.MessageEventContent{MsgType: event.MsgText, Body: "secret words 2"},
		RelatesTo:  &event.RelatesTo{Type: event.RelReplace, EventID: msg.EventID},
	}}
	if _, err := ghost.SendMessage(ctx, room, event.EventMessage, edit, nil); err != nil {
		t.Fatalf("SendMessage edit: %v", err)
	}
	if found, err := st.Search(ctx, "secret", 10); err != nil || len(found) != 2 {
		t.Fatalf("Search before redaction = %d, %v; want 2", len(found), err)
	}

	redactEvent(t, ghost, room, msg.EventID)

	editRow := findReplacement(t, st, room, msg.EventID)
	if strings.Contains(string(editRow.Content), "secret") ||
		strings.Contains(string(editRow.Content), `"body"`) ||
		strings.Contains(string(editRow.Content), "m.new_content") {
		t.Fatalf("edit row still carries content: %s", editRow.Content)
	}
	got, err := st.GetEvent(ctx, msg.EventID)
	if err != nil || got == nil || !got.Redacted {
		t.Fatalf("original after redaction = %+v, %v; want redacted", got, err)
	}
	if found, err := st.Search(ctx, "secret", 10); err != nil || len(found) != 0 {
		t.Fatalf("Search after redaction = %d, %v; want none", len(found), err)
	}
}

// A redaction whose target has not arrived yet is remembered, and the
// late-arriving target is stored redacted with no body; the tombstone is
// consumed by the insert.
func TestRedactionBeforeTarget(t *testing.T) {
	c, st, sink := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)
	key := networkid.PortalKey{ID: "chat-1"}
	target := c.GenerateDeterministicEventID(room, key, "msg-late", "p0")

	redactEvent(t, ghost, room, target)
	var tombstones int
	if err := st.DB.QueryRow(ctx, `SELECT COUNT(*) FROM redaction_tombstone WHERE event_id = $1`, target).Scan(&tombstones); err != nil || tombstones != 1 {
		t.Fatalf("tombstone after early redaction = %d, %v; want 1", tombstones, err)
	}

	part := &bridgev2.MatrixSendExtra{MessageMeta: &database.Message{ID: "msg-late", PartID: "p0", Room: key}}
	sent, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("late body"), part)
	if err != nil {
		t.Fatalf("SendMessage late target: %v", err)
	}
	if sent.EventID != target {
		t.Fatalf("late target stored as %s; want %s", sent.EventID, target)
	}

	got, err := st.GetEvent(ctx, target)
	if err != nil || got == nil || !got.Redacted {
		t.Fatalf("late target = %+v, %v; want Redacted=true", got, err)
	}
	if strings.Contains(string(got.Content), "late body") || string(got.Content) != "{}" {
		t.Fatalf("late target content = %s; want {}", got.Content)
	}
	if found, err := st.Search(ctx, "late", 10); err != nil || len(found) != 0 {
		t.Fatalf("Search for late target = %d, %v; want none", len(found), err)
	}

	// Consumed exactly once: a second take finds nothing, and the pushed
	// event was redacted.
	consumed, err := st.TakeTombstone(ctx, target)
	if err != nil || consumed {
		t.Fatalf("TakeTombstone after insert = %v, %v; want false", consumed, err)
	}
	for _, call := range sink.snapshot() {
		if call.Kind == "message" && call.Event.ID == target && !call.Event.Redacted {
			t.Fatalf("pushed late target was not marked redacted: %+v", call.Event)
		}
	}
}

// An edit that arrives after its original was redacted is stored stripped
// and redacted, so the redacted body never re-enters the store or the
// full-text index.
func TestLateEditOfRedactedIsStripped(t *testing.T) {
	c, st, _ := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)

	msg, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("secret words"), nil)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	redactEvent(t, ghost, room, msg.EventID)

	edit := &event.Content{Parsed: &event.MessageEventContent{
		MsgType:    event.MsgText,
		Body:       "* secret words 2",
		NewContent: &event.MessageEventContent{MsgType: event.MsgText, Body: "secret words 2"},
		RelatesTo:  &event.RelatesTo{Type: event.RelReplace, EventID: msg.EventID},
	}}
	if _, err := ghost.SendMessage(ctx, room, event.EventMessage, edit, nil); err != nil {
		t.Fatalf("SendMessage late edit: %v", err)
	}

	editRow := findReplacement(t, st, room, msg.EventID)
	if !editRow.Redacted {
		t.Fatalf("late edit not marked redacted: %+v", editRow)
	}
	if strings.Contains(string(editRow.Content), "secret") ||
		strings.Contains(string(editRow.Content), `"body"`) ||
		strings.Contains(string(editRow.Content), "m.new_content") {
		t.Fatalf("late edit still carries content: %s", editRow.Content)
	}
	if found, err := st.Search(ctx, "secret", 10); err != nil || len(found) != 0 {
		t.Fatalf("Search after late edit = %d, %v; want none", len(found), err)
	}
}

// A redaction for a target that is not stored yet is followed by the target's
// edit and then the target itself: all of them end up stripped, and the
// redacted body is not searchable.
func TestEditBeforeTombstonedTarget(t *testing.T) {
	c, st, _ := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)
	key := networkid.PortalKey{ID: "chat-1"}
	target := c.GenerateDeterministicEventID(room, key, "msg-late", "p0")

	redactEvent(t, ghost, room, target)

	edit := &event.Content{Parsed: &event.MessageEventContent{
		MsgType:    event.MsgText,
		Body:       "* late body 2",
		NewContent: &event.MessageEventContent{MsgType: event.MsgText, Body: "late body 2"},
		RelatesTo:  &event.RelatesTo{Type: event.RelReplace, EventID: target},
	}}
	if _, err := ghost.SendMessage(ctx, room, event.EventMessage, edit, nil); err != nil {
		t.Fatalf("SendMessage edit: %v", err)
	}

	part := &bridgev2.MatrixSendExtra{MessageMeta: &database.Message{ID: "msg-late", PartID: "p0", Room: key}}
	sent, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("late body"), part)
	if err != nil {
		t.Fatalf("SendMessage late target: %v", err)
	}
	if sent.EventID != target {
		t.Fatalf("late target stored as %s; want %s", sent.EventID, target)
	}

	editRow := findReplacement(t, st, room, target)
	if !editRow.Redacted {
		t.Fatalf("edit of tombstoned target not marked redacted: %+v", editRow)
	}
	if strings.Contains(string(editRow.Content), "late body") ||
		strings.Contains(string(editRow.Content), `"body"`) ||
		strings.Contains(string(editRow.Content), "m.new_content") {
		t.Fatalf("edit of tombstoned target still carries content: %s", editRow.Content)
	}
	got, err := st.GetEvent(ctx, target)
	if err != nil || got == nil || !got.Redacted {
		t.Fatalf("late target = %+v, %v; want Redacted=true", got, err)
	}
	if strings.Contains(string(got.Content), "late body") {
		t.Fatalf("late target content = %s; want no body", got.Content)
	}
	if found, err := st.Search(ctx, "late", 10); err != nil || len(found) != 0 {
		t.Fatalf("Search after late arrivals = %d, %v; want none", len(found), err)
	}
}

// Redacting the last reference to a media file deletes it; while another
// non-redacted event still references the same mxc, the file stays.
func TestRedactDeletesUnreferencedMedia(t *testing.T) {
	c, st, _ := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)

	data := []byte("picture bytes")
	uri, _, err := ghost.UploadMedia(ctx, "", data, "pic.jpg", "image/jpeg")
	if err != nil {
		t.Fatalf("UploadMedia: %v", err)
	}
	sha := strings.TrimPrefix(string(uri), "mxc://truki.local/")
	path := filepath.Join(c.mediaDir, sha)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("media file missing before redaction: %v", err)
	}

	sendImage := func(body string) id.EventID {
		t.Helper()
		content := &event.Content{Parsed: &event.MessageEventContent{
			MsgType: event.MsgImage, Body: body, URL: uri,
		}}
		resp, err := ghost.SendMessage(ctx, room, event.EventMessage, content, nil)
		if err != nil {
			t.Fatalf("SendMessage image: %v", err)
		}
		return resp.EventID
	}
	first := sendImage("pic one")
	second := sendImage("pic two")

	if n, err := st.MediaRefCount(ctx, uri); err != nil || n != 2 {
		t.Fatalf("MediaRefCount before redaction = %d, %v; want 2", n, err)
	}

	redactEvent(t, ghost, room, second)
	if n, err := st.MediaRefCount(ctx, uri); err != nil || n != 1 {
		t.Fatalf("MediaRefCount after one redaction = %d, %v; want 1", n, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("media file deleted while still referenced: %v", err)
	}

	redactEvent(t, ghost, room, first)
	if n, err := st.MediaRefCount(ctx, uri); err != nil || n != 0 {
		t.Fatalf("MediaRefCount after both redactions = %d, %v; want 0", n, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("media file still on disk after last reference was redacted: %v", err)
	}

	// A file that is already gone is not an error.
	third := sendImage("pic three")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatalf("removing media file: %v", err)
	}
	redactEvent(t, ghost, room, third)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("media file reappeared: %v", err)
	}
}
