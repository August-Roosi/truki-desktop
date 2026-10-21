// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/faketest"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/rpc"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/trukiconnector"
)

// recordingSink records every message push, in order.
type recordingSink struct {
	mu       sync.Mutex
	messages []store.Event
}

func (s *recordingSink) Message(ev *store.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.messages = append(s.messages, *ev)
}

func (s *recordingSink) history(evID id.EventID) []store.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []store.Event
	for _, ev := range s.messages {
		if ev.ID == evID {
			out = append(out, ev)
		}
	}
	return out
}

func (s *recordingSink) Chat(*store.Chat)                                {}
func (s *recordingSink) AccountState(string, status.BridgeState)         {}
func (s *recordingSink) Notify(string, *bridgev2.DirectNotificationData) {}
func (s *recordingSink) Typing(id.RoomID, []id.UserID)                   {}
func (s *recordingSink) Receipt(id.RoomID, id.UserID, id.EventID)        {}

// env is a running bridge served over a real RPC pipe. newEnv additionally
// logs in alice and delivers one chat (chat1) holding the friend's message
// m1 ("tere"); newEnvBase stops before any login.
type env struct {
	t     *testing.T
	h     *host.Host
	st    *store.Store
	fake  *faketest.FakeNetwork
	sink  *recordingSink
	dir   string
	chat  id.RoomID
	m1    id.EventID // event ID of the friend's message "tere"
	resp  *bufio.Reader
	req   io.Writer
	reqID int
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Data struct {
			Code string `json:"code"`
		} `json:"data"`
	} `json:"error"`
}

var testKey = bytes.Repeat([]byte{7}, 32)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// newEnvBase returns a served env with no login: the fake network's bridge
// is not running yet, the state of a fresh data dir.
func newEnvBase(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "bridge.db"), testKey)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	st := store.New(db)
	if err := st.Upgrade(ctx); err != nil {
		t.Fatalf("upgrade store: %v", err)
	}
	e := &env{t: t, st: st, fake: faketest.NewFakeNetwork(), sink: &recordingSink{}, dir: dir}
	log := zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel)
	e.h = host.NewHost(db, st, dir, e.sink, []host.NetworkDef{{
		ID: "fake", Name: "Fake", Flows: []string{"fake"},
		New: func() bridgev2.NetworkConnector { return e.fake },
	}}, log)
	if err := e.h.Start(ctx); err != nil {
		t.Fatalf("start host: %v", err)
	}
	t.Cleanup(e.h.Stop)

	reqR, reqW := io.Pipe()
	respR, respW := io.Pipe()
	conn := rpc.NewConn(reqR, respW, zerolog.Nop())
	conn.HandleInit(func(context.Context, rpc.InitParams) (*rpc.InitResult, error) {
		return &rpc.InitResult{ProtocolVersion: rpc.ProtocolVersion}, nil
	})
	Register(conn, e.h, st)
	serveCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); _ = conn.Serve(serveCtx) }()
	t.Cleanup(func() {
		reqW.Close()
		cancel()
		respR.Close()
		<-done
	})
	e.req, e.resp = reqW, bufio.NewReader(respR)
	if r := e.call("init", map[string]any{"protocolVersion": rpc.ProtocolVersion, "dataDir": dir, "dbKey": strings.Repeat("0", 64)}); r.Error != nil {
		t.Fatalf("init failed: %+v", r.Error)
	}
	return e
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := newEnvBase(t)
	br, err := e.h.Bridge(context.Background(), "fake")
	if err != nil {
		t.Fatalf("bridge: %v", err)
	}
	e.login(br, "alice")
	e.fake.Deliver("alice", "chat1", "m1", "tere")
	waitFor(t, "incoming message", func() bool {
		chats, _, _ := e.st.ListChats(context.Background(), "", 10)
		if len(chats) != 1 {
			return false
		}
		e.chat = chats[0].ID
		events, _ := e.st.ListEvents(context.Background(), e.chat, 0, 10)
		for _, ev := range events {
			if ev.Type == event.EventMessage.Type && strings.Contains(string(ev.Content), "tere") {
				e.m1 = ev.ID
			}
		}
		return e.m1 != ""
	})
	return e
}

func (e *env) login(br *bridgev2.Bridge, username string) {
	e.t.Helper()
	ctx := context.Background()
	user, err := br.GetUserByMXID(ctx, trukiconnector.LocalUser)
	if err != nil {
		e.t.Fatalf("get local user: %v", err)
	}
	proc, err := br.Network.CreateLogin(ctx, user, "fake")
	if err != nil {
		e.t.Fatalf("create login: %v", err)
	}
	if _, err = proc.Start(ctx); err != nil {
		e.t.Fatalf("login start: %v", err)
	}
	if _, err = proc.(bridgev2.LoginProcessUserInput).SubmitUserInput(ctx, map[string]string{"username": username}); err != nil {
		e.t.Fatalf("login submit: %v", err)
	}
}

// call sends one request and returns its response. Calls are sequential.
func (e *env) call(method string, params any) rpcResponse {
	e.t.Helper()
	e.reqID++
	line, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": e.reqID, "method": method, "params": params})
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.req.Write(append(line, '\n')); err != nil {
		e.t.Fatalf("write request: %v", err)
	}
	raw, err := e.resp.ReadBytes('\n')
	if err != nil {
		e.t.Fatalf("read response: %v", err)
	}
	var r rpcResponse
	if err := json.Unmarshal(raw, &r); err != nil {
		e.t.Fatalf("bad response %q: %v", raw, err)
	}
	return r
}

// ok calls method, requires success and returns the eventId of the result.
func (e *env) ok(method string, params any) id.EventID {
	e.t.Helper()
	r := e.call(method, params)
	if r.Error != nil {
		e.t.Fatalf("%s failed: %+v", method, r.Error)
	}
	var out struct {
		EventID id.EventID `json:"eventId"`
	}
	if err := json.Unmarshal(r.Result, &out); err != nil {
		e.t.Fatalf("bad %s result %s: %v", method, r.Result, err)
	}
	return out.EventID
}

func (e *env) send(text string) id.EventID {
	e.t.Helper()
	return e.ok("messages.send", map[string]any{"chatId": e.chat, "text": text})
}

// finalStatus waits for the event's status to leave "pending" and returns
// the last pushed row.
func (e *env) finalStatus(evID id.EventID) store.Event {
	e.t.Helper()
	var last store.Event
	waitFor(e.t, "final status of "+string(evID), func() bool {
		h := e.sink.history(evID)
		if len(h) == 0 || h[len(h)-1].Status == "pending" {
			return false
		}
		last = h[len(h)-1]
		return true
	})
	return last
}

func (e *env) wantError(r rpcResponse, code string) {
	e.t.Helper()
	if r.Error == nil || r.Error.Data.Code != code {
		e.t.Fatalf("response = %+v / %s; want error %s", r.Error, r.Result, code)
	}
}

func TestSendText(t *testing.T) {
	e := newEnv(t)
	evID := e.send("hello there")
	if !strings.HasPrefix(string(evID), "$truki-") {
		t.Errorf("eventId = %q; want a $truki- ID", evID)
	}
	if first := e.sink.history(evID); len(first) == 0 || first[0].Status != "pending" {
		t.Errorf("first push of the outgoing event = %+v; want status pending", first)
	}
	got := e.finalStatus(evID)
	if got.Status != "sent" || got.Sender != trukiconnector.LocalUser || got.RoomID != e.chat {
		t.Errorf("final push = status %q sender %s room %s; want sent from the local user in %s", got.Status, got.Sender, got.RoomID, e.chat)
	}
	sent := e.fake.Sent()
	if len(sent) != 1 || sent[0].Text != "hello there" || sent[0].Portal.ID != "chat1" {
		t.Errorf("fake got %+v; want one message %q in chat1", sent, "hello there")
	}
	stored, _ := e.st.GetEvent(context.Background(), evID)
	if stored == nil || stored.Status != "sent" {
		t.Errorf("stored event = %+v; want status sent", stored)
	}
}

func TestSendFailure(t *testing.T) {
	e := newEnv(t)
	e.fake.FailNextSend(errors.New("network down"))
	evID := e.send("doomed")
	got := e.finalStatus(evID)
	if got.Status != "failed" || got.ErrorCode == "" {
		t.Errorf("final push = status %q code %q; want failed with an error code", got.Status, got.ErrorCode)
	}
}

func TestRateLimitedNotRetried(t *testing.T) {
	e := newEnv(t)
	e.fake.FailNextSend(faketest.ErrRateLimited)
	evID := e.send("too fast")
	got := e.finalStatus(evID)
	if got.Status != "failed" || got.ErrorCode != "RATE_LIMITED" {
		t.Errorf("final push = status %q code %q; want failed RATE_LIMITED", got.Status, got.ErrorCode)
	}
	// Events of a chat are handled in order, so once a later message is
	// sent, any automatic retry of the first would already have happened.
	e.finalStatus(e.send("sentinel"))
	if n := e.fake.SendAttempts(); n != 2 {
		t.Errorf("the network saw %d send attempts; want 2 (the rate-limited send once, then the sentinel)", n)
	}
}

func TestSendInvalidAndUnknown(t *testing.T) {
	e := newEnv(t)
	e.wantError(e.call("messages.send", map[string]any{"chatId": "!nope:truki.local", "text": "x"}), "NOT_FOUND")
	e.wantError(e.call("messages.send", map[string]any{"chatId": e.chat}), "INVALID_INPUT")
	e.wantError(e.call("messages.send", map[string]any{"text": "x"}), "INVALID_INPUT")
	e.wantError(e.call("messages.send", map[string]any{"chatId": e.chat, "text": "x", "bogus": 1}), "INVALID_INPUT")
	e.wantError(e.call("messages.send", map[string]any{"chatId": e.chat, "text": "x", "replyTo": "$unknown"}), "NOT_FOUND")
	e.wantError(e.call("messages.send", map[string]any{"chatId": e.chat, "attachments": []map[string]any{{"path": "/nonexistent/file.png", "name": "file.png"}}}), "INVALID_INPUT")
	e.wantError(e.call("messages.react", map[string]any{"chatId": e.chat, "eventId": e.m1}), "INVALID_INPUT")
	e.wantError(e.call("messages.react", map[string]any{"chatId": e.chat, "eventId": "$unknown", "key": "x"}), "NOT_FOUND")
	e.wantError(e.call("messages.redact", map[string]any{"chatId": e.chat, "eventId": "$unknown"}), "NOT_FOUND")
	e.wantError(e.call("chats.markRead", map[string]any{"chatId": "!nope:truki.local", "eventId": e.m1}), "NOT_FOUND")
	e.wantError(e.call("chats.setMuted", map[string]any{"chatId": e.chat, "until": "tomorrow"}), "INVALID_INPUT")
	e.wantError(e.call("chats.setMuted", map[string]any{"chatId": "!nope:truki.local"}), "NOT_FOUND")
	if n := e.fake.SendAttempts(); n != 0 {
		t.Errorf("the network saw %d sends for rejected requests; want 0", n)
	}
}

func TestReply(t *testing.T) {
	e := newEnv(t)
	evID := e.ok("messages.send", map[string]any{"chatId": e.chat, "text": "answer", "replyTo": e.m1})
	if got := e.finalStatus(evID); got.Status != "sent" {
		t.Fatalf("reply status = %q; want sent", got.Status)
	}
	sent := e.fake.Sent()
	if len(sent) != 1 || sent[0].ReplyTo != "m1" {
		t.Errorf("fake got %+v; want one message replying to m1", sent)
	}
	stored, _ := e.st.GetEvent(context.Background(), evID)
	if stored == nil || stored.RelatesTo != e.m1 {
		t.Errorf("stored reply relates to %v; want %s", stored, e.m1)
	}
}

func TestReactAndRedact(t *testing.T) {
	e := newEnv(t)
	reactID := e.ok("messages.react", map[string]any{"chatId": e.chat, "eventId": e.m1, "key": "👍"})
	if got := e.finalStatus(reactID); got.Status != "sent" || got.Type != event.EventReaction.Type {
		t.Fatalf("reaction push = %+v; want a sent m.reaction", got)
	}
	want := []faketest.FakeReaction{{Login: "alice", Message: "m1", Emoji: "👍"}}
	if got := e.fake.Reactions(); !slices.Equal(got, want) {
		t.Fatalf("fake reactions = %+v; want %+v", got, want)
	}

	// Redacting the reaction removes it.
	e.ok("messages.redact", map[string]any{"chatId": e.chat, "eventId": reactID})
	waitFor(t, "reaction removal", func() bool { return len(e.fake.Reactions()) == 2 })
	want = append(want, faketest.FakeReaction{Login: "alice", Message: "m1", Emoji: "👍", Removed: true})
	if got := e.fake.Reactions(); !slices.Equal(got, want) {
		t.Errorf("fake reactions = %+v; want %+v", got, want)
	}

	// Redacting one of our own messages deletes it.
	msgID := e.send("oops")
	e.finalStatus(msgID)
	e.ok("messages.redact", map[string]any{"chatId": e.chat, "eventId": msgID})
	waitFor(t, "message removal", func() bool { return len(e.fake.Removals()) == 1 })
	if got := e.fake.Removals()[0]; got.Message != "sent-1" {
		t.Errorf("fake removed %+v; want sent-1", got)
	}
	waitFor(t, "message marked redacted", func() bool {
		stored, _ := e.st.GetEvent(context.Background(), msgID)
		return stored != nil && stored.Redacted
	})
}

func TestMarkRead(t *testing.T) {
	e := newEnv(t)
	e.fake.Deliver("alice", "chat1", "m2", "tere jälle")
	waitFor(t, "two unread messages", func() bool {
		chat, _ := e.st.GetChat(context.Background(), e.chat)
		return chat != nil && chat.UnreadCount == 2
	})
	chat, _ := e.st.GetChat(context.Background(), e.chat)
	e.ok("chats.markRead", map[string]any{"chatId": e.chat, "eventId": chat.LastEventID})
	chat, _ = e.st.GetChat(context.Background(), e.chat)
	if chat.UnreadCount != 0 {
		t.Errorf("unread count = %d after markRead; want 0", chat.UnreadCount)
	}
	waitFor(t, "read receipt at the network", func() bool { return len(e.fake.Receipts()) == 1 })
	if got := e.fake.Receipts()[0]; got.Portal.ID != "chat1" || got.Message != "m2" || got.Login != "alice" {
		t.Errorf("fake receipt = %+v; want alice's receipt for m2 in chat1", got)
	}
}

func TestSetMuted(t *testing.T) {
	e := newEnv(t)
	until := time.Now().Add(time.Hour).Truncate(time.Second)
	e.ok("chats.setMuted", map[string]any{"chatId": e.chat, "until": until.Format(time.RFC3339)})
	chat, _ := e.st.GetChat(context.Background(), e.chat)
	if !chat.MutedUntil.Equal(until) {
		t.Errorf("muted until %v; want %v", chat.MutedUntil, until)
	}
	e.ok("chats.setMuted", map[string]any{"chatId": e.chat})
	chat, _ = e.st.GetChat(context.Background(), e.chat)
	if !chat.MutedUntil.IsZero() {
		t.Errorf("muted until %v after unmuting; want zero", chat.MutedUntil)
	}
}

func TestSendAttachment(t *testing.T) {
	e := newEnv(t)
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{1, 2, 3}, 100)...)
	path := filepath.Join(t.TempDir(), "pic.png")
	if err := os.WriteFile(path, png, 0o600); err != nil {
		t.Fatal(err)
	}
	evID := e.ok("messages.send", map[string]any{"chatId": e.chat, "attachments": []map[string]any{
		{"path": path, "name": "pic.png", "mimeType": "image/png"},
	}})
	if got := e.finalStatus(evID); got.Status != "sent" {
		t.Fatalf("attachment status = %q (%s); want sent", got.Status, got.ErrorCode)
	}
	sent := e.fake.Sent()
	if len(sent) != 1 || !bytes.Equal(sent[0].File, png) || sent[0].FileName != "pic.png" || sent[0].MimeType != "image/png" {
		t.Errorf("fake got %d messages (file %d bytes, name %q, type %q); want the PNG's %d bytes",
			len(sent), len(sent[0].File), sent[0].FileName, sent[0].MimeType, len(png))
	}
	var content event.MessageEventContent
	stored, _ := e.st.GetEvent(context.Background(), evID)
	if err := json.Unmarshal(stored.Content, &content); err != nil || content.MsgType != event.MsgImage {
		t.Errorf("stored content = %s; want an m.image", stored.Content)
	}
}

func TestCommandLookalikesAreDelivered(t *testing.T) {
	e := newEnv(t)
	texts := []string{"!fake help", "!fake", "!fake logout", "!wait what", "!", "!fakeish"}
	for _, text := range texts {
		e.ok("messages.send", map[string]any{"chatId": e.chat, "text": text})
	}
	var evID id.EventID
	for range texts {
		evID = e.send("after")
		e.finalStatus(evID)
	}
	sent := e.fake.Sent()
	var got []string
	for _, s := range sent {
		got = append(got, s.Text)
	}
	if !slices.Equal(got[:len(texts)], texts) {
		t.Fatalf("network got %q; want the texts verbatim %q", got, texts)
	}
	waitFor(t, "all sent", func() bool {
		events, _ := e.st.ListEvents(context.Background(), e.chat, 0, 100)
		n := 0
		for _, ev := range events {
			if ev.Sender == trukiconnector.LocalUser && ev.Status == "sent" {
				n++
			}
		}
		return n == len(texts)+len(texts)
	})
}

func TestCaptionStartingWithBangIsDelivered(t *testing.T) {
	e := newEnv(t)
	path := filepath.Join(t.TempDir(), "a.bin")
	if err := os.WriteFile(path, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	evID := e.ok("messages.send", map[string]any{"chatId": e.chat, "text": "!fake logout", "attachments": []map[string]any{
		{"path": path, "name": "a.bin", "mimeType": "application/octet-stream"},
	}})
	if got := e.finalStatus(evID); got.Status != "sent" {
		t.Fatalf("status = %q; want sent", got.Status)
	}
	if sent := e.fake.Sent(); len(sent) != 1 || sent[0].Text != "!fake logout" || string(sent[0].File) != "data" {
		t.Errorf("network got %+v; want the file with caption %q", sent, "!fake logout")
	}
}

type listChatsResult struct {
	Chats []struct {
		ID          string `json:"id"`
		Network     string `json:"network"`
		Name        string `json:"name"`
		UnreadCount int    `json:"unreadCount"`
		IsDM        bool   `json:"isDm"`
	} `json:"chats"`
	NextCursor string `json:"nextCursor"`
}

func TestNetworksList(t *testing.T) {
	e := newEnv(t)
	r := e.call("networks.list", nil)
	if r.Error != nil {
		t.Fatalf("networks.list: %+v", r.Error)
	}
	var nets []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.Unmarshal(r.Result, &nets); err != nil {
		t.Fatalf("networks.list result %s: %v", r.Result, err)
	}
	if len(nets) != 1 || nets[0].ID != "fake" || nets[0].Name != "Fake" || !nets[0].Enabled {
		t.Fatalf("networks.list = %+v; want one enabled fake network", nets)
	}
}

// enabled asks networks.list whether network reports itself enabled.
func (e *env) enabled(network string) bool {
	e.t.Helper()
	r := e.call("networks.list", nil)
	if r.Error != nil {
		e.t.Fatalf("networks.list: %+v", r.Error)
	}
	var nets []struct {
		ID      string `json:"id"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.Unmarshal(r.Result, &nets); err != nil {
		e.t.Fatalf("networks.list result %s: %v", r.Result, err)
	}
	for _, n := range nets {
		if n.ID == network {
			return n.Enabled
		}
	}
	e.t.Fatalf("network %q missing from networks.list %s", network, r.Result)
	return false
}

// TestNetworksListEnabledMeansLoggedIn pins enabled to "the network has at
// least one logged-in account": a bridge that login flows start lazily, or
// that keeps running after the last logout, must not count.
func TestNetworksListEnabledMeansLoggedIn(t *testing.T) {
	e := newEnvBase(t)

	// login.flows starts the bridge lazily; with no account the network is
	// still disabled.
	if r := e.call("login.flows", map[string]any{"network": "fake"}); r.Error != nil {
		t.Fatalf("login.flows: %+v", r.Error)
	}
	if e.enabled("fake") {
		t.Error("enabled = true after login.flows with no login; want false")
	}

	// A started-then-cancelled login leaves the bridge running but adds no
	// account.
	r := e.call("login.start", map[string]any{"network": "fake", "flowId": "fake"})
	if r.Error != nil {
		t.Fatalf("login.start: %+v", r.Error)
	}
	var start struct {
		ProcessID string `json:"processId"`
	}
	if err := json.Unmarshal(r.Result, &start); err != nil || start.ProcessID == "" {
		t.Fatalf("login.start result %s (%v); want a processId", r.Result, err)
	}
	if r := e.call("login.cancel", map[string]any{"processId": start.ProcessID}); r.Error != nil {
		t.Fatalf("login.cancel: %+v", r.Error)
	}
	if e.enabled("fake") {
		t.Error("enabled = true after a cancelled login; want false")
	}

	// A completed login enables the network.
	br, err := e.h.Bridge(context.Background(), "fake")
	if err != nil {
		t.Fatalf("bridge: %v", err)
	}
	e.login(br, "alice")
	if !e.enabled("fake") {
		t.Error("enabled = false after a completed login; want true")
	}

	// Logging the only account out disables it again, even though the
	// bridge keeps running.
	if r := e.call("accounts.logout", map[string]any{"network": "fake", "loginId": "alice"}); r.Error != nil {
		t.Fatalf("accounts.logout: %+v", r.Error)
	}
	if e.enabled("fake") {
		t.Error("enabled = true after logging out the only account; want false")
	}
}

func TestChatsListPaging(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	base := time.Now()
	for i, name := range []string{"old", "mid", "new"} {
		chat := &store.Chat{
			ID:           id.RoomID("!" + name + ":truki.local"),
			Network:      "fake",
			LoginID:      "alice",
			PortalID:     name,
			Name:         name,
			LastActivity: base.Add(time.Duration(i+1) * time.Hour),
		}
		if err := e.st.PutChat(ctx, chat); err != nil {
			t.Fatalf("put chat %s: %v", name, err)
		}
	}

	// Newest first: new, mid, then the fixture chat (whose activity is now).
	var page listChatsResult
	r := e.call("chats.list", map[string]any{"limit": 2})
	if r.Error != nil {
		t.Fatalf("chats.list: %+v", r.Error)
	}
	if err := json.Unmarshal(r.Result, &page); err != nil {
		t.Fatalf("chats.list result %s: %v", r.Result, err)
	}
	if len(page.Chats) != 2 || page.Chats[0].ID != "!new:truki.local" || page.Chats[1].ID != "!mid:truki.local" {
		t.Fatalf("first page = %+v; want new then mid", page.Chats)
	}
	if page.NextCursor == "" {
		t.Fatal("nextCursor is empty with more chats to come")
	}
	if page.Chats[0].Network != "fake" || page.Chats[0].UnreadCount != 0 || page.Chats[0].IsDM {
		t.Errorf("chat fields = %+v; want network fake, 0 unread, not a DM", page.Chats[0])
	}

	r = e.call("chats.list", map[string]any{"cursor": page.NextCursor, "limit": 2})
	if r.Error != nil {
		t.Fatalf("chats.list page 2: %+v", r.Error)
	}
	if err := json.Unmarshal(r.Result, &page); err != nil {
		t.Fatalf("chats.list page 2 result %s: %v", r.Result, err)
	}
	if len(page.Chats) != 2 || page.Chats[0].ID != "!old:truki.local" || page.Chats[1].ID != string(e.chat) {
		t.Fatalf("second page = %+v; want old then the fixture chat", page.Chats)
	}

	// A full last page still gets a cursor; the next page is empty.
	r = e.call("chats.list", map[string]any{"cursor": page.NextCursor, "limit": 2})
	if r.Error != nil {
		t.Fatalf("chats.list page 3: %+v", r.Error)
	}
	if err := json.Unmarshal(r.Result, &page); err != nil {
		t.Fatalf("chats.list page 3 result %s: %v", r.Result, err)
	}
	if len(page.Chats) != 0 || page.NextCursor != "" {
		t.Fatalf("third page = %+v (cursor %q); want empty with no cursor", page.Chats, page.NextCursor)
	}

	// Default and clamped limits, and a bad cursor.
	r = e.call("chats.list", nil)
	if r.Error != nil {
		t.Fatalf("chats.list without params: %+v", r.Error)
	}
	if err := json.Unmarshal(r.Result, &page); err != nil {
		t.Fatalf("chats.list default result %s: %v", r.Result, err)
	}
	if len(page.Chats) != 4 || page.NextCursor != "" {
		t.Fatalf("default page = %d chats, cursor %q; want all 4, no cursor", len(page.Chats), page.NextCursor)
	}
	r = e.call("chats.list", map[string]any{"limit": 10000})
	if r.Error != nil {
		t.Fatalf("chats.list with an oversized limit: %+v", r.Error)
	}
	e.wantError(e.call("chats.list", map[string]any{"cursor": "!!!not-base64!!!", "limit": 2}), "INVALID_INPUT")
	e.wantError(e.call("chats.list", map[string]any{"limit": "many"}), "INVALID_INPUT")
}

func TestChatsGet(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	member := &event.MemberEventContent{Membership: event.MembershipJoin, Displayname: "Friend"}
	if err := e.st.PutMember(ctx, e.chat, "@fake_friend:truki.local", member); err != nil {
		t.Fatalf("put member: %v", err)
	}
	r := e.call("chats.get", map[string]any{"chatId": e.chat})
	if r.Error != nil {
		t.Fatalf("chats.get: %+v", r.Error)
	}
	var out struct {
		Chat struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"chat"`
		Members map[string]struct {
			Membership  string `json:"membership"`
			DisplayName string `json:"displayname"`
		} `json:"members"`
	}
	if err := json.Unmarshal(r.Result, &out); err != nil {
		t.Fatalf("chats.get result %s: %v", r.Result, err)
	}
	if out.Chat.ID != string(e.chat) {
		t.Errorf("chat.id = %q; want %q", out.Chat.ID, e.chat)
	}
	if m, ok := out.Members["@fake_friend:truki.local"]; !ok || m.Membership != "join" || m.DisplayName != "Friend" {
		t.Errorf("members = %+v; want the friend's join with display name Friend", out.Members)
	}

	e.wantError(e.call("chats.get", map[string]any{"chatId": "!nope:truki.local"}), "NOT_FOUND")
	e.wantError(e.call("chats.get", map[string]any{}), "INVALID_INPUT")
	e.wantError(e.call("chats.get", map[string]any{"chatId": e.chat, "bogus": 1}), "INVALID_INPUT")
}

type listEventsResult struct {
	Events []struct {
		ID          string          `json:"id"`
		ChatID      string          `json:"chatId"`
		Sender      string          `json:"sender"`
		Type        string          `json:"type"`
		Content     json.RawMessage `json:"content"`
		Status      string          `json:"status"`
		StreamOrder int64           `json:"streamOrder"`
	} `json:"events"`
}

func TestMessagesListPaging(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		content, err := json.Marshal(event.MessageEventContent{MsgType: event.MsgText, Body: fmt.Sprintf("page %d", i)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.st.PutEvent(ctx, &store.Event{
			ID:        id.EventID(fmt.Sprintf("$page-%d:truki.local", i)),
			RoomID:    e.chat,
			Sender:    trukiconnector.LocalUser,
			Type:      event.EventMessage.Type,
			Content:   content,
			Timestamp: time.Now(),
		}); err != nil {
			t.Fatalf("put event %d: %v", i, err)
		}
	}

	// Newest first, three per page.
	var page listEventsResult
	r := e.call("messages.list", map[string]any{"chatId": e.chat, "limit": 3})
	if r.Error != nil {
		t.Fatalf("messages.list: %+v", r.Error)
	}
	if err := json.Unmarshal(r.Result, &page); err != nil {
		t.Fatalf("messages.list result %s: %v", r.Result, err)
	}
	want := []string{"$page-5:truki.local", "$page-4:truki.local", "$page-3:truki.local"}
	for i, ev := range page.Events {
		if ev.ID != want[i] {
			t.Fatalf("first page = %+v; want %q", page.Events, want)
		}
		if ev.ChatID != string(e.chat) || ev.Sender != string(trukiconnector.LocalUser) || ev.StreamOrder == 0 {
			t.Errorf("event fields = %+v; want the chat, the local sender and a stream order", ev)
		}
	}

	// before pages below the oldest event of the first page.
	r = e.call("messages.list", map[string]any{"chatId": e.chat, "before": page.Events[2].StreamOrder, "limit": 3})
	if r.Error != nil {
		t.Fatalf("messages.list page 2: %+v", r.Error)
	}
	if err := json.Unmarshal(r.Result, &page); err != nil {
		t.Fatalf("messages.list page 2 result %s: %v", r.Result, err)
	}
	want = []string{"$page-2:truki.local", "$page-1:truki.local", string(e.m1)}
	for i, ev := range page.Events {
		if ev.ID != want[i] {
			t.Fatalf("second page = %+v; want %q", page.Events, want)
		}
	}

	// An oversized limit is clamped, not an error.
	r = e.call("messages.list", map[string]any{"chatId": e.chat, "limit": 10000})
	if r.Error != nil {
		t.Fatalf("messages.list with an oversized limit: %+v", r.Error)
	}
	if err := json.Unmarshal(r.Result, &page); err != nil {
		t.Fatalf("messages.list result %s: %v", r.Result, err)
	}
	if len(page.Events) != 6 {
		t.Fatalf("clamped page = %d events; want all 6", len(page.Events))
	}

	e.wantError(e.call("messages.list", map[string]any{"chatId": "!nope:truki.local"}), "NOT_FOUND")
	e.wantError(e.call("messages.list", map[string]any{}), "INVALID_INPUT")
	e.wantError(e.call("messages.list", map[string]any{"chatId": e.chat, "before": "soon"}), "INVALID_INPUT")
}

func TestMediaPathTraversal(t *testing.T) {
	e := newEnv(t)
	mediaDir := filepath.Join(e.dir, "media")

	// Anything that is not an mxc URI cannot name a file at all.
	for _, bad := range []string{"../../truki-bridge.key", "/etc/passwd", "mxc:/truki.local/x"} {
		e.wantError(e.call("media.path", map[string]any{"mediaId": bad}), "INVALID_INPUT")
	}
	e.wantError(e.call("media.path", map[string]any{}), "INVALID_INPUT")

	// A well-formed URI that names nothing in the media store.
	for _, bad := range []string{"mxc://evil.example/x", "mxc://truki.local/../x"} {
		e.wantError(e.call("media.path", map[string]any{"mediaId": bad}), "NOT_FOUND")
	}

	// A real upload resolves to its file inside <dataDir>/media.
	data := []byte("truki media bytes")
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	if err := os.MkdirAll(mediaDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaDir, hash), data, 0o600); err != nil {
		t.Fatal(err)
	}
	r := e.call("media.path", map[string]any{"mediaId": "mxc://truki.local/" + hash})
	if r.Error != nil {
		t.Fatalf("media.path: %+v", r.Error)
	}
	var out struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(r.Result, &out); err != nil {
		t.Fatalf("media.path result %s: %v", r.Result, err)
	}
	if want := filepath.Join(mediaDir, hash); out.Path != want {
		t.Errorf("media.path = %q; want %q", out.Path, want)
	}

	// A local URI whose file was never uploaded.
	e.wantError(e.call("media.path", map[string]any{"mediaId": "mxc://truki.local/" + strings.Repeat("ab", 32)}), "NOT_FOUND")
}

func TestSearchBadQuery(t *testing.T) {
	e := newEnv(t)
	e.wantError(e.call("search", map[string]any{"query": "\"unbalanced"}), "INVALID_INPUT")
	e.wantError(e.call("search", map[string]any{}), "INVALID_INPUT")
	e.wantError(e.call("search", map[string]any{"query": "tere", "bogus": 1}), "INVALID_INPUT")

	// The fixture message is findable.
	r := e.call("search", map[string]any{"query": "tere"})
	if r.Error != nil {
		t.Fatalf("search: %+v", r.Error)
	}
	var events []struct {
		ID     string `json:"id"`
		ChatID string `json:"chatId"`
	}
	if err := json.Unmarshal(r.Result, &events); err != nil {
		t.Fatalf("search result %s: %v", r.Result, err)
	}
	found := false
	for _, ev := range events {
		if ev.ID == string(e.m1) && ev.ChatID == string(e.chat) {
			found = true
		}
	}
	if !found {
		t.Errorf("search for tere = %+v; want the fixture message", events)
	}
}
