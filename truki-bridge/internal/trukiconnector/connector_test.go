// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package trukiconnector

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// sinkCall is one recorded Sink invocation.
type sinkCall struct {
	Kind    string // message|chat|accountState|notify|typing|receipt
	Event   *store.Event
	Chat    *store.Chat
	Network string
	State   status.BridgeState
	Notify  *bridgev2.DirectNotificationData
	Room    id.RoomID
	Users   []id.UserID
	User    id.UserID
	EventID id.EventID
}

// recordingSink records every call in order.
type recordingSink struct {
	mu    sync.Mutex
	calls []sinkCall
}

func (s *recordingSink) add(c sinkCall) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, c)
}

func (s *recordingSink) Message(ev *store.Event) { s.add(sinkCall{Kind: "message", Event: ev}) }
func (s *recordingSink) Chat(c *store.Chat)      { s.add(sinkCall{Kind: "chat", Chat: c}) }
func (s *recordingSink) AccountState(network string, st status.BridgeState) {
	s.add(sinkCall{Kind: "accountState", Network: network, State: st})
}
func (s *recordingSink) Notify(network string, d *bridgev2.DirectNotificationData) {
	s.add(sinkCall{Kind: "notify", Network: network, Notify: d})
}
func (s *recordingSink) Typing(room id.RoomID, users []id.UserID) {
	s.add(sinkCall{Kind: "typing", Room: room, Users: users})
}
func (s *recordingSink) Receipt(room id.RoomID, user id.UserID, ev id.EventID) {
	s.add(sinkCall{Kind: "receipt", Room: room, User: user, EventID: ev})
}

func (s *recordingSink) snapshot() []sinkCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.calls)
}

func (s *recordingSink) kinds() []string {
	var out []string
	for _, c := range s.snapshot() {
		out = append(out, c.Kind)
	}
	return out
}

func (s *recordingSink) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = nil
}

const testNetwork = "whatsapp"

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"), bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	st := store.New(db)
	if err := st.Upgrade(context.Background()); err != nil {
		t.Fatalf("upgrade store: %v", err)
	}
	return st
}

func newTestConnector(t *testing.T) (*Connector, *store.Store, *recordingSink) {
	t.Helper()
	st := newTestStore(t)
	sink := &recordingSink{}
	return New(testNetwork, st, filepath.Join(t.TempDir(), "media"), sink), st, sink
}

// createRoom creates a portal-like room through a ghost intent.
func createRoom(t *testing.T, c *Connector, creator bridgev2.MatrixAPI) id.RoomID {
	t.Helper()
	room, err := creator.CreateRoom(context.Background(), &mautrix.ReqCreateRoom{
		Name:     "Test chat",
		IsDirect: true,
	})
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	return room
}

func textContent(body string) *event.Content {
	return &event.Content{Parsed: &event.MessageEventContent{MsgType: event.MsgText, Body: body}}
}

func TestGhostIDRoundTrip(t *testing.T) {
	c, _, _ := newTestConnector(t)
	in := networkid.UserID("+372 5555/x")
	mxid := c.FormatGhostMXID(in)
	if !strings.HasPrefix(string(mxid), "@whatsapp_") || !strings.HasSuffix(string(mxid), ":truki.local") {
		t.Fatalf("unexpected ghost MXID shape %q", mxid)
	}
	got, ok := c.ParseGhostMXID(mxid)
	if !ok || got != in {
		t.Fatalf("ParseGhostMXID(%q) = %q, %v; want %q, true", mxid, got, ok, in)
	}

	other := New("meta", c.store, t.TempDir(), &recordingSink{})
	for _, foreign := range []id.UserID{
		other.FormatGhostMXID(in),                    // another network
		id.NewUserID("whatsapp_abc", "evil.example"), // another server
		LocalUser,
		BotMXID,
	} {
		if _, ok := c.ParseGhostMXID(foreign); ok {
			t.Errorf("ParseGhostMXID(%q) = true; want false", foreign)
		}
	}
}

func TestDeterministicIDsStable(t *testing.T) {
	a, _, _ := newTestConnector(t)
	b, _, _ := newTestConnector(t)
	key := networkid.PortalKey{ID: "chat-1", Receiver: "login-1"}

	roomA, roomB := a.GenerateDeterministicRoomID(key), b.GenerateDeterministicRoomID(key)
	if roomA != roomB {
		t.Fatalf("room IDs differ: %q vs %q", roomA, roomB)
	}
	if !regexp.MustCompile(`^![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:truki\.local$`).MatchString(string(roomA)) {
		t.Fatalf("room ID %q is not !<uuid>:truki.local", roomA)
	}
	if other := a.GenerateDeterministicRoomID(networkid.PortalKey{ID: "chat-1", Receiver: "login-2"}); other == roomA {
		t.Fatalf("different receivers produced the same room ID")
	}

	evA := a.GenerateDeterministicEventID(roomA, key, "msg-1", "part-0")
	evB := b.GenerateDeterministicEventID(roomB, key, "msg-1", "part-0")
	if evA != evB {
		t.Fatalf("event IDs differ: %q vs %q", evA, evB)
	}
	if !regexp.MustCompile(`^\$[A-Za-z0-9_-]{43}$`).MatchString(string(evA)) {
		t.Fatalf("event ID %q is not $ + 43 base64url chars", evA)
	}
	if other := a.GenerateDeterministicEventID(roomA, key, "msg-1", "part-1"); other == evA {
		t.Fatalf("different part IDs produced the same event ID")
	}
}

func TestCreateRoomAndSend(t *testing.T) {
	c, st, sink := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")

	room := createRoom(t, c, ghost)
	if !strings.HasPrefix(string(room), "!") || !strings.HasSuffix(string(room), ":truki.local") {
		t.Fatalf("unexpected room ID %q", room)
	}
	resp, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("hi"), nil)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	chats, _, err := st.ListChats(ctx, "", 10)
	if err != nil || len(chats) != 1 {
		t.Fatalf("ListChats = %d chats, %v; want 1", len(chats), err)
	}
	if chats[0].ID != room || chats[0].Name != "Test chat" || !chats[0].IsDM || chats[0].Network != testNetwork {
		t.Fatalf("unexpected chat row %+v", chats[0])
	}
	events, err := st.ListEvents(ctx, room, 0, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("ListEvents = %d events, %v; want 1", len(events), err)
	}
	ev := events[0]
	if ev.ID != resp.EventID || ev.Sender != c.FormatGhostMXID("alice") || ev.Type != event.EventMessage.Type {
		t.Fatalf("unexpected event row %+v", ev)
	}
	var body struct {
		Body string `json:"body"`
	}
	if err := json.Unmarshal(ev.Content, &body); err != nil || body.Body != "hi" {
		t.Fatalf("event content %s: body %q, %v", ev.Content, body.Body, err)
	}

	kinds := sink.kinds()
	if len(kinds) < 2 || kinds[0] != "chat" || kinds[1] != "message" {
		t.Fatalf("sink calls = %v; want chat then message first", kinds)
	}
	if got := sink.snapshot()[1].Event; got.ID != resp.EventID {
		t.Fatalf("sink message event %q; want %q", got.ID, resp.EventID)
	}
}

func TestSendMessageDuplicate(t *testing.T) {
	c, st, sink := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)
	key := networkid.PortalKey{ID: "chat-1", Receiver: "login-1"}
	evID := c.GenerateDeterministicEventID(room, key, "msg-1", "")
	ts := time.UnixMilli(1_700_000_000_123)

	batch := func() {
		t.Helper()
		_, err := c.BatchSend(ctx, room, &mautrix.ReqBeeperBatchSend{
			Forward: true,
			Events: []*event.Event{{
				ID:        evID,
				RoomID:    room,
				Sender:    ghost.GetMXID(),
				Type:      event.EventMessage,
				Timestamp: ts.UnixMilli(),
				Content:   *textContent("once"),
			}},
		}, []*bridgev2.MatrixSendExtra{{Timestamp: ts}})
		if err != nil {
			t.Fatalf("BatchSend: %v", err)
		}
	}
	sink.reset()
	batch()
	batch()

	events, err := st.ListEvents(ctx, room, 0, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("ListEvents = %d events, %v; want 1", len(events), err)
	}
	if events[0].ID != evID || !events[0].Timestamp.Equal(ts) {
		t.Fatalf("unexpected event %+v", events[0])
	}
	if kinds := sink.kinds(); len(kinds) != 1 {
		t.Fatalf("sink calls = %v; want exactly one", kinds)
	}

	// A retried SendMessage with the same transaction ID is the same event.
	sink.reset()
	extra := &bridgev2.MatrixSendExtra{Timestamp: ts, TransactionID: "txn-1"}
	r1, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("retry"), extra)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	r2, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("retry"), extra)
	if err != nil {
		t.Fatalf("SendMessage retry: %v", err)
	}
	if r1.EventID != r2.EventID {
		t.Fatalf("retry produced a new event ID: %q vs %q", r1.EventID, r2.EventID)
	}
	events, _ = st.ListEvents(ctx, room, 0, 10)
	if len(events) != 2 {
		t.Fatalf("ListEvents = %d events; want 2", len(events))
	}
	messages := 0
	for _, k := range sink.kinds() {
		if k == "message" {
			messages++
		}
	}
	if messages != 1 {
		t.Fatalf("sink message calls = %d (%v); want 1", messages, sink.kinds())
	}
}

func TestUploadDownloadMedia(t *testing.T) {
	c, _, _ := newTestConnector(t)
	ctx := context.Background()
	intent := c.GhostIntent("alice")
	data := []byte("picture bytes")

	uri, file, err := intent.UploadMedia(ctx, "", data, "a.jpg", "image/jpeg")
	if err != nil || file != nil {
		t.Fatalf("UploadMedia = %q, %v, %v", uri, file, err)
	}
	if !regexp.MustCompile(`^mxc://truki\.local/[0-9a-f]{64}$`).MatchString(string(uri)) {
		t.Fatalf("unexpected content URI %q", uri)
	}
	sha := strings.TrimPrefix(string(uri), "mxc://truki.local/")
	if onDisk, err := os.ReadFile(filepath.Join(c.mediaDir, sha)); err != nil || !bytes.Equal(onDisk, data) {
		t.Fatalf("media file: %q, %v", onDisk, err)
	}
	got, err := intent.DownloadMedia(ctx, uri, nil)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("DownloadMedia = %q, %v", got, err)
	}

	streamed, _, err := intent.UploadMediaStream(ctx, "", -1, true, func(w io.Writer) (*bridgev2.FileStreamResult, error) {
		_, err := w.Write(data)
		return &bridgev2.FileStreamResult{FileName: "a.jpg", MimeType: "image/jpeg"}, err
	})
	if err != nil || streamed != uri {
		t.Fatalf("UploadMediaStream = %q, %v; want %q", streamed, err, uri)
	}
	err = intent.DownloadMediaToFile(ctx, uri, nil, false, func(f *os.File) error {
		b, err := io.ReadAll(f)
		if err == nil && !bytes.Equal(b, data) {
			t.Errorf("DownloadMediaToFile read %q", b)
		}
		return err
	})
	if err != nil {
		t.Fatalf("DownloadMediaToFile: %v", err)
	}

	if _, err := c.ParseContentURI(ctx, "mxc://evil.example/"+id.ContentURIString(sha)); err == nil {
		t.Fatalf("ParseContentURI accepted a foreign server")
	}
	if _, err := intent.DownloadMedia(ctx, "mxc://evil.example/"+id.ContentURIString(sha), nil); err == nil {
		t.Fatalf("DownloadMedia accepted a foreign server")
	}
	if _, err := intent.DownloadMedia(ctx, "mxc://truki.local/..", nil); err == nil {
		t.Fatalf("DownloadMedia accepted a non-hash media ID")
	}

	direct, err := c.GenerateContentURI(ctx, networkid.MediaID("remote/media\x00id"))
	if err != nil {
		t.Fatalf("GenerateContentURI: %v", err)
	}
	if mediaID, err := c.ParseContentURI(ctx, direct); err != nil || string(mediaID) != "remote/media\x00id" {
		t.Fatalf("ParseContentURI(%q) = %q, %v", direct, mediaID, err)
	}
}

func TestMarkReadUpdatesUnread(t *testing.T) {
	c, st, sink := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)

	if _, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("one"), nil); err != nil {
		t.Fatal(err)
	}
	last, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("two"), nil)
	if err != nil {
		t.Fatal(err)
	}
	chat, err := st.GetChat(ctx, room)
	if err != nil || chat.UnreadCount != 2 || chat.LastEventID != last.EventID {
		t.Fatalf("chat after two messages = %+v, %v; want UnreadCount 2", chat, err)
	}

	me, _, err := c.NewUserIntent(ctx, LocalUser, "")
	if err != nil || me == nil || me.GetMXID() != LocalUser || !me.IsDoublePuppet() {
		t.Fatalf("NewUserIntent(LocalUser) = %v, %v", me, err)
	}
	sink.reset()
	if err := me.MarkRead(ctx, room, last.EventID, time.Now()); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	chat, _ = st.GetChat(ctx, room)
	if chat.UnreadCount != 0 {
		t.Fatalf("UnreadCount after MarkRead = %d; want 0", chat.UnreadCount)
	}
	calls := sink.snapshot()
	if len(calls) != 1 || calls[0].Kind != "chat" || calls[0].Chat.UnreadCount != 0 {
		t.Fatalf("sink calls = %v; want one chat with UnreadCount 0", sink.kinds())
	}
}

func TestMemberStateServedBack(t *testing.T) {
	c, _, _ := newTestConnector(t)
	ctx := context.Background()
	bot := c.BotIntent()
	room := createRoom(t, c, bot)

	for _, user := range []id.UserID{c.FormatGhostMXID("alice"), c.FormatGhostMXID("bob")} {
		_, err := bot.SendState(ctx, room, event.StateMember, user.String(), &event.Content{
			Parsed: &event.MemberEventContent{Membership: event.MembershipJoin, Displayname: string(user)[1:6]},
		}, time.Now())
		if err != nil {
			t.Fatalf("SendState(%s): %v", user, err)
		}
	}
	members, err := c.GetMembers(ctx, room)
	if err != nil {
		t.Fatalf("GetMembers: %v", err)
	}
	for _, user := range []id.UserID{c.FormatGhostMXID("alice"), c.FormatGhostMXID("bob")} {
		if m := members[user]; m == nil || m.Membership != event.MembershipJoin {
			t.Errorf("member %s = %+v; want join", user, m)
		}
	}
	info, err := c.GetMemberInfo(ctx, room, c.FormatGhostMXID("bob"))
	if err != nil || info == nil || info.Displayname != "whats" {
		t.Fatalf("GetMemberInfo = %+v, %v", info, err)
	}
	pl, err := c.GetPowerLevels(ctx, room)
	if err != nil || pl == nil {
		t.Fatalf("GetPowerLevels = %v, %v; want non-nil", pl, err)
	}
}

func TestGhostTypingAndReceipt(t *testing.T) {
	c, _, sink := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)
	me, _, _ := c.NewUserIntent(ctx, LocalUser, "")
	mine, err := me.SendMessage(ctx, room, event.EventMessage, textContent("hello alice"), nil)
	if err != nil {
		t.Fatal(err)
	}

	sink.reset()
	if err := ghost.MarkTyping(ctx, room, bridgev2.TypingTypeText, 5*time.Second); err != nil {
		t.Fatalf("MarkTyping: %v", err)
	}
	if err := ghost.MarkRead(ctx, room, mine.EventID, time.Now()); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if err := ghost.MarkTyping(ctx, room, bridgev2.TypingTypeText, 0); err != nil {
		t.Fatalf("MarkTyping stop: %v", err)
	}
	calls := sink.snapshot()
	if len(calls) != 3 {
		t.Fatalf("sink calls = %v; want typing, receipt, typing", sink.kinds())
	}
	if calls[0].Kind != "typing" || calls[0].Room != room || !slices.Equal(calls[0].Users, []id.UserID{ghost.GetMXID()}) {
		t.Fatalf("typing call = %+v", calls[0])
	}
	if calls[1].Kind != "receipt" || calls[1].Room != room || calls[1].User != ghost.GetMXID() || calls[1].EventID != mine.EventID {
		t.Fatalf("receipt call = %+v", calls[1])
	}
	if calls[2].Kind != "typing" || len(calls[2].Users) != 0 {
		t.Fatalf("stop-typing call = %+v", calls[2])
	}
}

func TestDisplayNotification(t *testing.T) {
	c, _, sink := newTestConnector(t)
	data := &bridgev2.DirectNotificationData{MessageID: "msg-1", Message: "hello", FormattedTitle: "Alice"}
	c.DisplayNotification(context.Background(), data)
	calls := sink.snapshot()
	if len(calls) != 1 || calls[0].Kind != "notify" || calls[0].Notify != data || calls[0].Network != testNetwork {
		t.Fatalf("sink calls = %+v; want one notify with the same data", calls)
	}
}

func TestBridgeAndMessageStatus(t *testing.T) {
	c, st, sink := newTestConnector(t)
	ctx := context.Background()
	me, _, _ := c.NewUserIntent(ctx, LocalUser, "")
	room := createRoom(t, c, c.BotIntent())
	sent, err := me.SendMessage(ctx, room, event.EventMessage, textContent("out"), nil)
	if err != nil {
		t.Fatal(err)
	}

	sink.reset()
	if err := c.SendBridgeStatus(ctx, &status.BridgeState{StateEvent: status.StateConnected}); err != nil {
		t.Fatalf("SendBridgeStatus: %v", err)
	}
	c.SendMessageStatus(ctx, &bridgev2.MessageStatus{
		Status:      event.MessageStatusFail,
		ErrorReason: event.MessageStatusNetworkError,
	}, &bridgev2.MessageStatusEventInfo{RoomID: room, SourceEventID: sent.EventID, EventType: event.EventMessage})

	ev, err := st.GetEvent(ctx, sent.EventID)
	if err != nil || ev.Status != "failed" || ev.ErrorCode != string(event.MessageStatusNetworkError) {
		t.Fatalf("event after status = %+v, %v", ev, err)
	}
	calls := sink.snapshot()
	if len(calls) != 2 || calls[0].Kind != "accountState" || calls[0].State.StateEvent != status.StateConnected ||
		calls[1].Kind != "message" || calls[1].Event.Status != "failed" {
		t.Fatalf("sink calls = %+v", calls)
	}
}

func TestNoOpMethodsDoNotFail(t *testing.T) {
	c, _, _ := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)
	checks := map[string]error{
		"SetDisplayName":      ghost.SetDisplayName(ctx, "Alice"),
		"SetAvatarURL":        ghost.SetAvatarURL(ctx, "mxc://truki.local/x"),
		"SetExtraProfileMeta": ghost.SetExtraProfileMeta(ctx, map[string]any{"a": 1}),
		"SetProfile":          ghost.SetProfile(ctx, map[string]any{"a": 1}),
		"EnsureJoined":        ghost.EnsureJoined(ctx, room),
		"EnsureInvited":       ghost.EnsureInvited(ctx, room, c.FormatGhostMXID("bob")),
		"TagRoom":             ghost.TagRoom(ctx, room, event.RoomTagFavourite, true),
		"MuteRoom":            ghost.MuteRoom(ctx, room, time.Now().Add(time.Hour)),
		"MarkUnread":          ghost.MarkUnread(ctx, room, true),
		"DeleteRoom":          ghost.DeleteRoom(ctx, room, false),
		"Start":               c.Start(ctx),
	}
	for name, err := range checks {
		if err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	c.PreStop()
	c.Stop()
	caps := c.GetCapabilities()
	if !caps.AutoJoinInvites || !caps.BatchSending {
		t.Fatalf("capabilities = %+v", caps)
	}
	if c.ServerName() != ServerName {
		t.Fatalf("ServerName = %q", c.ServerName())
	}
}

func TestBackwardBackfillOrder(t *testing.T) {
	c, st, _ := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)
	key := networkid.PortalKey{ID: "chat-1"}
	base := time.UnixMilli(1_700_000_000_000)

	batch := func(req *mautrix.ReqBeeperBatchSend, names ...string) {
		t.Helper()
		for idx, name := range names {
			req.Events = append(req.Events, &event.Event{
				ID:        c.GenerateDeterministicEventID(room, key, networkid.MessageID(name), ""),
				Sender:    ghost.GetMXID(),
				Type:      event.EventMessage,
				Timestamp: base.Add(time.Duration(idx) * time.Minute).UnixMilli(),
				Content:   *textContent(name),
			})
		}
		if _, err := c.BatchSend(ctx, room, req, nil); err != nil {
			t.Fatalf("BatchSend: %v", err)
		}
	}
	// Initial forward backfill into the empty room, as bridgev2 sends it.
	batch(&mautrix.ReqBeeperBatchSend{ForwardIfNoMessages: true}, "forward1", "forward2", "forward3")

	live, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("live"),
		&bridgev2.MatrixSendExtra{Timestamp: base.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	me, _, _ := c.NewUserIntent(ctx, LocalUser, "")
	if err := me.MarkRead(ctx, room, live.EventID, time.Now()); err != nil {
		t.Fatal(err)
	}

	// History backfill: oldest-first, Forward false, room not empty.
	base = base.Add(-24 * time.Hour)
	batch(&mautrix.ReqBeeperBatchSend{ForwardIfNoMessages: true}, "back1", "back2")

	events, err := st.ListEvents(ctx, room, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	var bodies []string
	for _, ev := range events {
		var b struct {
			Body string `json:"body"`
		}
		_ = json.Unmarshal(ev.Content, &b)
		bodies = append(bodies, b.Body)
	}
	want := []string{"live", "forward3", "forward2", "forward1", "back2", "back1"}
	if !slices.Equal(bodies, want) {
		t.Fatalf("timeline newest-first = %v; want %v", bodies, want)
	}

	chat, _ := st.GetChat(ctx, room)
	if chat.UnreadCount != 0 || chat.LastEventID != live.EventID {
		t.Fatalf("chat after backward batch = %+v; want unread 0, last event live", chat)
	}
	if err := me.MarkRead(ctx, room, live.EventID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if chat, _ = st.GetChat(ctx, room); chat.UnreadCount != 0 {
		t.Fatalf("UnreadCount after re-reading live = %d; want 0", chat.UnreadCount)
	}
}

func TestBackfilledReactionDedup(t *testing.T) {
	c, st, _ := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)
	target := &database.Message{
		ID: "msg-1", PartID: "", MXID: "$target",
		Room: networkid.PortalKey{ID: "chat-1", Receiver: "login-1"},
	}
	reactionID := func() id.EventID {
		return c.GenerateReactionEventID(room, target, "alice", "👍")
	}
	if reactionID() != reactionID() {
		t.Fatalf("reaction event IDs are not deterministic")
	}
	if c.GenerateReactionEventID(room, target, "bob", "👍") == reactionID() {
		t.Fatalf("different senders produced the same reaction ID")
	}
	if c.GenerateReactionEventID(room, nil, "alice", "👍") == c.GenerateReactionEventID(room, nil, "alice", "👍") {
		t.Fatalf("nil target should fall back to random IDs")
	}
	// One-reaction-per-user networks have no emoji ID: a changed reaction
	// must not hash to the old reaction's event ID.
	if c.GenerateReactionEventID(room, target, "alice", "") == c.GenerateReactionEventID(room, target, "alice", "") {
		t.Fatalf("empty emoji ID should fall back to random IDs")
	}

	for range 2 {
		_, err := c.BatchSend(ctx, room, &mautrix.ReqBeeperBatchSend{Forward: true, Events: []*event.Event{{
			ID:     reactionID(),
			Sender: ghost.GetMXID(),
			Type:   event.EventReaction,
			Content: event.Content{Parsed: &event.ReactionEventContent{RelatesTo: event.RelatesTo{
				Type: event.RelAnnotation, EventID: target.MXID, Key: "👍",
			}}},
		}}}, nil)
		if err != nil {
			t.Fatalf("BatchSend: %v", err)
		}
	}
	events, _ := st.ListEvents(ctx, room, 0, 10)
	if len(events) != 1 {
		t.Fatalf("stored %d reaction rows; want 1", len(events))
	}
}

// A remote message bridged live gets the deterministic event ID of its
// message part, so a replay after a crash (bridgev2 had not yet saved its
// message row) stores nothing new. Edits and redactions carry the existing
// part (with its MXID) and keep getting fresh IDs.
func TestLiveRemoteMessageDeterministicID(t *testing.T) {
	c, st, _ := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)
	key := networkid.PortalKey{ID: "chat-1"}
	part := func() *bridgev2.MatrixSendExtra {
		return &bridgev2.MatrixSendExtra{MessageMeta: &database.Message{ID: "msg-1", PartID: "p0", Room: key}}
	}

	r1, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("live"), part())
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if want := c.GenerateDeterministicEventID(room, key, "msg-1", "p0"); r1.EventID != want {
		t.Fatalf("event ID = %s; want deterministic %s", r1.EventID, want)
	}
	r2, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("live"), part())
	if err != nil || r2.EventID != r1.EventID {
		t.Fatalf("replay = %v, %v; want %s", r2, err, r1.EventID)
	}

	edit := part()
	edit.MessageMeta.MXID = r1.EventID
	r3, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("edited"), edit)
	if err != nil || r3.EventID == r1.EventID {
		t.Fatalf("edit = %v, %v; want a new event ID", r3, err)
	}
	events, err := st.ListEvents(ctx, room, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, ev := range events {
		if ev.Type == event.EventMessage.Type {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("stored %d messages; want 2 (original + edit)", n)
	}
}

// A redaction strips the target's body from the store, the search index and
// the event pushed to the client; a replay of the message cannot restore it.
func TestRedactionStripsContent(t *testing.T) {
	c, st, sink := newTestConnector(t)
	ctx := context.Background()
	ghost := c.GhostIntent("alice")
	room := createRoom(t, c, ghost)
	key := networkid.PortalKey{ID: "chat-1"}
	part := func() *bridgev2.MatrixSendExtra {
		return &bridgev2.MatrixSendExtra{MessageMeta: &database.Message{ID: "msg-1", PartID: "p0", Room: key}}
	}

	msg, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("secret words"), part())
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if found, err := st.Search(ctx, "secret", 10); err != nil || len(found) != 1 {
		t.Fatalf("Search before redaction = %d, %v; want 1", len(found), err)
	}

	reaction := &event.Content{Parsed: &event.ReactionEventContent{RelatesTo: event.RelatesTo{
		Type: event.RelAnnotation, EventID: msg.EventID, Key: "👍",
	}}}
	react, err := ghost.SendMessage(ctx, room, event.EventReaction, reaction, nil)
	if err != nil {
		t.Fatalf("SendMessage reaction: %v", err)
	}

	sink.reset()
	redact := func(target id.EventID) {
		t.Helper()
		content := &event.Content{Parsed: &event.RedactionEventContent{Redacts: target}}
		if _, err := ghost.SendMessage(ctx, room, event.EventRedaction, content, nil); err != nil {
			t.Fatalf("SendMessage redaction: %v", err)
		}
	}
	redact(msg.EventID)
	redact(react.EventID)

	assertNoBody := func(where string, content json.RawMessage) {
		t.Helper()
		if strings.Contains(string(content), "secret") || strings.Contains(string(content), "body") {
			t.Fatalf("%s still carries the body: %s", where, content)
		}
	}
	got, err := st.GetEvent(ctx, msg.EventID)
	if err != nil || got == nil || !got.Redacted {
		t.Fatalf("GetEvent = %+v, %v; want a redacted event", got, err)
	}
	assertNoBody("stored event", got.Content)
	if string(got.Content) != "{}" {
		t.Fatalf("redacted message content = %s; want {}", got.Content)
	}

	pushed := 0
	for _, call := range sink.snapshot() {
		if call.Kind == "message" && call.Event.ID == msg.EventID {
			pushed++
			if !call.Event.Redacted {
				t.Fatalf("pushed event for the redaction is not marked redacted")
			}
			assertNoBody("pushed event", call.Event.Content)
		}
	}
	if pushed != 1 {
		t.Fatalf("pushed the redacted message %d times; want 1", pushed)
	}

	// A redacted reaction keeps its relation so the client can drop it.
	gotReact, err := st.GetEvent(ctx, react.EventID)
	if err != nil || gotReact == nil || !gotReact.Redacted {
		t.Fatalf("GetEvent reaction = %+v, %v; want redacted", gotReact, err)
	}
	if gotReact.RelatesTo != msg.EventID || gotReact.RelType != string(event.RelAnnotation) ||
		!strings.Contains(string(gotReact.Content), string(msg.EventID)) {
		t.Fatalf("redacted reaction lost its relation: %+v %s", gotReact, gotReact.Content)
	}

	// Replaying the original message part must not bring the body back.
	if _, err := ghost.SendMessage(ctx, room, event.EventMessage, textContent("secret words"), part()); err != nil {
		t.Fatalf("replay SendMessage: %v", err)
	}
	got, err = st.GetEvent(ctx, msg.EventID)
	if err != nil || got == nil {
		t.Fatalf("GetEvent after replay = %v", err)
	}
	assertNoBody("stored event after replay", got.Content)

	for _, q := range []string{"secret", "words"} {
		if found, err := st.Search(ctx, q, 10); err != nil || len(found) != 0 {
			t.Fatalf("Search(%q) after redaction = %d, %v; want none", q, len(found), err)
		}
	}
	// The index itself no longer holds the words, not only the filtered query.
	var indexed int
	if err := st.DB.QueryRow(ctx, `SELECT COUNT(*) FROM event_fts WHERE event_fts MATCH 'secret'`).Scan(&indexed); err != nil {
		t.Fatalf("count FTS rows: %v", err)
	}
	if indexed != 0 {
		t.Fatalf("FTS index still matches 'secret' %d times", indexed)
	}
}
