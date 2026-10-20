// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package host

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/faketest"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/trukiconnector"
)

// recordingSink records the chats and messages the connector pushes.
type recordingSink struct {
	mu       sync.Mutex
	chats    []*store.Chat
	messages []*store.Event
	states   []status.BridgeState
}

func (s *recordingSink) Message(ev *store.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.messages = append(s.messages, ev)
}

func (s *recordingSink) Chat(c *store.Chat) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.chats = append(s.chats, c)
}

func (s *recordingSink) AccountState(_ string, st status.BridgeState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.states = append(s.states, st)
}

func (s *recordingSink) Notify(string, *bridgev2.DirectNotificationData) {}
func (s *recordingSink) Typing(id.RoomID, []id.UserID)                   {}
func (s *recordingSink) Receipt(id.RoomID, id.UserID, id.EventID)        {}

func (s *recordingSink) snapshot() ([]*store.Chat, []*store.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.chats), slices.Clone(s.messages)
}

var testKey = bytes.Repeat([]byte{9}, 32)

// openDB opens (or reopens) the encrypted test database and upgrades the
// Truki tables.
func openDB(t *testing.T, path string) (*dbutil.Database, *store.Store) {
	t.Helper()
	db, err := store.Open(path, testKey)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	st := store.New(db)
	if err := st.Upgrade(context.Background()); err != nil {
		t.Fatalf("upgrade store: %v", err)
	}
	return db, st
}

func fakeDefs(fake *faketest.FakeNetwork) []NetworkDef {
	return []NetworkDef{{
		ID:    "fake",
		Name:  "Fake",
		New:   func() bridgev2.NetworkConnector { return fake },
		Flows: []string{"fake"},
	}}
}

// login runs the fake network's login flow for username as the local user.
func login(t *testing.T, ctx context.Context, br *bridgev2.Bridge, username string) *bridgev2.UserLogin {
	t.Helper()
	user, err := br.GetUserByMXID(ctx, trukiconnector.LocalUser)
	if err != nil {
		t.Fatalf("get local user: %v", err)
	}
	if !user.Permissions.Admin || !user.Permissions.Login {
		t.Fatalf("local user permissions = %+v; want admin", user.Permissions)
	}
	proc, err := br.Network.CreateLogin(ctx, user, "fake")
	if err != nil {
		t.Fatalf("create login: %v", err)
	}
	step, err := proc.Start(ctx)
	if err != nil {
		t.Fatalf("login start: %v", err)
	}
	if step.Type != bridgev2.LoginStepTypeUserInput || len(step.UserInputParams.Fields) != 1 ||
		step.UserInputParams.Fields[0].ID != "username" {
		t.Fatalf("first login step = %+v; want user_input with one username field", step)
	}
	step, err = proc.(bridgev2.LoginProcessUserInput).SubmitUserInput(ctx, map[string]string{"username": username})
	if err != nil {
		t.Fatalf("submit username: %v", err)
	}
	if step.Type != bridgev2.LoginStepTypeComplete || step.CompleteParams.UserLogin == nil {
		t.Fatalf("second login step = %+v; want complete", step)
	}
	if step.CompleteParams.UserLogin.UserMXID != trukiconnector.LocalUser {
		t.Fatalf("login owner = %s; want %s", step.CompleteParams.UserLogin.UserMXID, trukiconnector.LocalUser)
	}
	return step.CompleteParams.UserLogin
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func body(ev *store.Event) string {
	var c event.MessageEventContent
	_ = json.Unmarshal(ev.Content, &c)
	return c.Body
}

// messageBodies returns the bodies of the room's m.room.message events,
// oldest first.
func messageBodies(t *testing.T, st *store.Store, room id.RoomID) []string {
	t.Helper()
	events, err := st.ListEvents(context.Background(), room, 0, 1000)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	var out []string
	for _, ev := range slices.Backward(events) {
		if ev.Type == event.EventMessage.Type {
			out = append(out, body(ev))
		}
	}
	return out
}

func onlyChat(t *testing.T, st *store.Store) *store.Chat {
	t.Helper()
	chats, _, err := st.ListChats(context.Background(), "", 100)
	if err != nil {
		t.Fatalf("list chats: %v", err)
	}
	if len(chats) != 1 {
		t.Fatalf("store has %d chats; want 1", len(chats))
	}
	return chats[0]
}

func TestFakeLoginAndIncoming(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, st := openDB(t, filepath.Join(dir, "bridge.db"))
	defer db.Close()
	sink := &recordingSink{}
	fake := faketest.NewFakeNetwork()
	h := NewHost(db, st, dir, sink, fakeDefs(fake), testLog(t))
	if err := h.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer h.Stop()

	br, err := h.Bridge(ctx, "fake")
	if err != nil {
		t.Fatalf("bridge: %v", err)
	}
	if fake.Config.Greeting != "hello" {
		t.Errorf("network config greeting = %q; want the example's %q", fake.Config.Greeting, "hello")
	}
	if br.Config.OutgoingMessageReID || br.Config.PersonalFilteringSpaces || !br.Config.Backfill.Enabled {
		t.Errorf("bridge config = %+v; want re-ID off, filtering spaces off, backfill on", br.Config)
	}
	login(t, ctx, br, "alice")

	fake.Deliver("alice", "chat1", "m1", "tere")

	var got *store.Event
	waitFor(t, "chat and message in sink", func() bool {
		chats, msgs := sink.snapshot()
		hasChat := slices.ContainsFunc(chats, func(c *store.Chat) bool { return c.Network == "fake" })
		idx := slices.IndexFunc(msgs, func(ev *store.Event) bool { return body(ev) == "tere" })
		if idx >= 0 {
			got = msgs[idx]
		}
		return hasChat && idx >= 0
	})
	chat := onlyChat(t, st)
	if chat.Network != "fake" {
		t.Errorf("chat network = %q; want fake", chat.Network)
	}
	if chat.PortalID != "chat1" || chat.LoginID != "alice" {
		t.Errorf("chat portal/login = %q/%q; want chat1/alice", chat.PortalID, chat.LoginID)
	}
	if got.RoomID != chat.ID {
		t.Errorf("message room = %s; want %s", got.RoomID, chat.ID)
	}
	if want := id.UserID("@fake_friend:truki.local"); got.Sender != want {
		t.Errorf("message sender = %s; want %s", got.Sender, want)
	}
	if bodies := messageBodies(t, st, chat.ID); !slices.Equal(bodies, []string{"tere"}) {
		t.Errorf("stored messages = %q; want [tere]", bodies)
	}
	if u, err := br.GetExistingUserByMXID(ctx, trukiconnector.LocalUser); err != nil || u == nil {
		t.Errorf("local user: %v, %v", u, err)
	} else if u.ManagementRoom != "" {
		t.Errorf("a management room %s was created; want none", u.ManagementRoom)
	}
}

func TestRestartNoDuplicates(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "bridge.db")

	db, st := openDB(t, path)
	fake := faketest.NewFakeNetwork()
	h := NewHost(db, st, dir, &recordingSink{}, fakeDefs(fake), testLog(t))
	if err := h.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	br, err := h.Bridge(ctx, "fake")
	if err != nil {
		t.Fatalf("bridge: %v", err)
	}
	login(t, ctx, br, "alice")
	ids := []networkid.MessageID{"m1", "m2", "m3"}
	for i, msgID := range ids {
		fake.Deliver("alice", "chat1", msgID, []string{"one", "two", "three"}[i])
	}
	want := []string{"one", "two", "three"}
	var room id.RoomID
	waitFor(t, "three stored messages", func() bool {
		chats, _, _ := st.ListChats(ctx, "", 10)
		if len(chats) != 1 {
			return false
		}
		room = chats[0].ID
		return len(messageBodies(t, st, room)) == 3
	})
	h.Stop()
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}

	db, st = openDB(t, path)
	defer db.Close()
	fake2 := faketest.NewFakeNetwork()
	h2 := NewHost(db, st, dir, &recordingSink{}, fakeDefs(fake2), testLog(t))
	if err := h2.Start(ctx); err != nil {
		t.Fatalf("restart: %v", err)
	}
	defer h2.Stop()
	if n := fake2.StartCount(); n != 1 {
		t.Fatalf("network with a login started %d times on restart; want 1", n)
	}
	// Simulated backfill: the network replays the same message IDs, then a
	// new message. Portal events are handled in order, so once the new one
	// is stored the replays have been handled too.
	for i, msgID := range ids {
		fake2.Deliver("alice", "chat1", msgID, want[i])
	}
	fake2.Deliver("alice", "chat1", "m4", "four")
	waitFor(t, "sentinel message", func() bool {
		return slices.Contains(messageBodies(t, st, room), "four")
	})
	if got := messageBodies(t, st, room); !slices.Equal(got, append(want, "four")) {
		t.Errorf("messages after replay = %q; want %q", got, append(want, "four"))
	}
	onlyChat(t, st)
}

func TestLazyStart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, st := openDB(t, filepath.Join(dir, "bridge.db"))
	defer db.Close()
	fake := faketest.NewFakeNetwork()
	h := NewHost(db, st, dir, &recordingSink{}, fakeDefs(fake), testLog(t))
	if err := h.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer h.Stop()
	if n := fake.StartCount(); n != 0 {
		t.Fatalf("network without logins started %d times; want 0", n)
	}
	br1, err := h.Bridge(ctx, "fake")
	if err != nil {
		t.Fatalf("bridge: %v", err)
	}
	br2, err := h.Bridge(ctx, "fake")
	if err != nil {
		t.Fatalf("bridge again: %v", err)
	}
	if br1 != br2 || fake.StartCount() != 1 {
		t.Errorf("Bridge twice: same=%v starts=%d; want same bridge, 1 start", br1 == br2, fake.StartCount())
	}
	if _, err := h.Bridge(ctx, "nope"); err == nil {
		t.Error("Bridge(unknown network) succeeded; want error")
	}
}

func TestStripTemplatedLines(t *testing.T) {
	in := "a: 1\ncommand_prefix: '$<<or .X>>'\nnested:\n    b: $<<.Y>>\n    c: 2\n"
	want := "a: 1\nnested:\n    c: 2\n"
	if got := stripTemplatedLines(in); got != want {
		t.Errorf("stripTemplatedLines = %q; want %q", got, want)
	}
}

// testLog sends bridge warnings and errors to the test log.
func testLog(t *testing.T) zerolog.Logger {
	return zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel)
}
