// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"maunium.net/go/mautrix/id"
)

// TestFailPendingEvents covers startup cleanup: a pending send cannot
// survive a bridge restart (nothing will ever report its final status), so
// every still-pending event is failed with error code INTERNAL. Events with
// any other status keep it, and a second run is a no-op.
func TestFailPendingEvents(t *testing.T) {
	s := newTestDB(t)
	ctx := context.Background()
	if err := s.Upgrade(ctx); err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}
	room := id.RoomID("!room:truki.local")
	for name, status := range map[string]string{
		"pending": "pending",
		"sent":    "sent",
		"failed":  "failed",
		"unset":   "",
	} {
		ev := &Event{
			ID:        id.EventID(fmt.Sprintf("$%s:truki.local", name)),
			RoomID:    room,
			Sender:    "@me:truki.local",
			Type:      "m.room.message",
			Content:   json.RawMessage(`{"body":"x","msgtype":"m.text"}`),
			Timestamp: time.Now(),
			Status:    status,
		}
		if _, err := s.PutEvent(ctx, ev); err != nil {
			t.Fatalf("put %s event: %v", name, err)
		}
	}

	n, err := s.FailPendingEvents(ctx)
	if err != nil {
		t.Fatalf("FailPendingEvents: %v", err)
	}
	if n != 1 {
		t.Fatalf("failed %d events; want only the pending one", n)
	}

	want := map[string]struct{ status, code string }{
		"pending": {"failed", "INTERNAL"},
		"sent":    {"sent", ""},
		"failed":  {"failed", ""},
		"unset":   {"", ""},
	}
	for name, w := range want {
		ev, err := s.GetEvent(ctx, id.EventID(fmt.Sprintf("$%s:truki.local", name)))
		if err != nil || ev == nil {
			t.Fatalf("get %s event: %v, %v", name, ev, err)
		}
		if ev.Status != w.status || ev.ErrorCode != w.code {
			t.Errorf("%s event = status %q code %q; want %q / %q", name, ev.Status, ev.ErrorCode, w.status, w.code)
		}
	}

	if n, err := s.FailPendingEvents(ctx); err != nil || n != 0 {
		t.Fatalf("second FailPendingEvents = %d, %v; want 0, nil", n, err)
	}
}
