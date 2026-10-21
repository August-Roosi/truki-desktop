// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package login

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/faketest"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/rpc"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

var testKey = bytes.Repeat([]byte{7}, 32)

// sink records the account states the bridge reports and ignores the rest.
type sink struct {
	mu     sync.Mutex
	states []status.BridgeStateEvent
}

func (s *sink) AccountState(_ string, st status.BridgeState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.states = append(s.states, st.StateEvent)
}

func (s *sink) has(ev status.BridgeStateEvent) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, got := range s.states {
		if got == ev {
			return true
		}
	}
	return false
}

func (s *sink) Message(*store.Event)                            {}
func (s *sink) Chat(*store.Chat)                                {}
func (s *sink) Notify(string, *bridgev2.DirectNotificationData) {}
func (s *sink) Typing(id.RoomID, []id.UserID)                   {}
func (s *sink) Receipt(id.RoomID, id.UserID, id.EventID)        {}

// pushed is one notification the manager sent.
type pushed struct {
	method string
	params any
}

// pushes collects notifications.
type pushes struct {
	mu   sync.Mutex
	list []pushed
}

func (p *pushes) notify(method string, params any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.list = append(p.list, pushed{method, params})
}

// forProcess returns the event.login.step pushes of one process, in order.
func (p *pushes) forProcess(processID string) []StepEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []StepEvent
	for _, n := range p.list {
		if ev, ok := n.params.(StepEvent); ok && n.method == "event.login.step" && ev.ProcessID == processID {
			out = append(out, ev)
		}
	}
	return out
}

// syncBuffer is a bytes.Buffer safe for the concurrent loggers of the bridge.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type env struct {
	t      *testing.T
	fake   *faketest.FakeNetwork
	sink   *sink
	pushes *pushes
	m      *Manager
	logs   *syncBuffer
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// newEnv builds a manager over a host with one network "fake" whose allowed
// flows are flows.
func newEnv(t *testing.T, flows ...string) *env {
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
	e := &env{t: t, fake: faketest.NewFakeNetwork(), sink: &sink{}, pushes: &pushes{}, logs: &syncBuffer{}}
	log := zerolog.New(e.logs).Level(zerolog.DebugLevel)
	h := host.NewHost(db, st, dir, e.sink, []host.NetworkDef{{
		ID: "fake", Name: "Fake", Flows: flows,
		New: func() bridgev2.NetworkConnector { return e.fake },
	}}, log)
	t.Cleanup(h.Stop)
	e.m = NewManager(h, e.pushes.notify, log)
	return e
}

func (e *env) start(flow string) *StepResult {
	e.t.Helper()
	r, err := e.m.Start(context.Background(), "fake", flow)
	if err != nil {
		e.t.Fatalf("start %s: %v", flow, err)
	}
	return r
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	re, ok := err.(*rpc.Error)
	if !ok || re.Code != code {
		t.Fatalf("error = %v; want %s", err, code)
	}
}

func (e *env) accounts() []Account {
	e.t.Helper()
	a, err := e.m.Accounts(context.Background())
	if err != nil {
		e.t.Fatalf("accounts: %v", err)
	}
	return a
}

func TestLoginUserInputFlow(t *testing.T) {
	e := newEnv(t, "fake")
	ctx := context.Background()
	r := e.start("fake")
	if r.ProcessID == "" || r.Step.Type != bridgev2.LoginStepTypeUserInput {
		t.Fatalf("start = %+v; want a user_input step with a process ID", r)
	}
	done, err := e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID, Input: map[string]string{"username": "a"}})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if done.Step.Type != bridgev2.LoginStepTypeComplete || done.Step.CompleteParams.UserLoginID != "a" {
		t.Fatalf("submit step = %+v; want complete for login a", done.Step)
	}
	if done.Seq <= r.Seq {
		t.Errorf("seq %d after %d; want it to grow", done.Seq, r.Seq)
	}
	accts := e.accounts()
	if len(accts) != 1 || accts[0].LoginID != "a" || accts[0].Network != "fake" || accts[0].RemoteName != "a" {
		t.Fatalf("accounts = %+v; want the one login a on fake", accts)
	}
	waitFor(t, "CONNECTED account state", func() bool { return e.sink.has(status.StateConnected) })
	waitFor(t, "state CONNECTED in the account list", func() bool { return e.accounts()[0].State == string(status.StateConnected) })
	// The process is gone once complete.
	_, err = e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID})
	wantCode(t, err, rpc.CodeNotFound)
}

func TestLoginQRRefresh(t *testing.T) {
	e := newEnv(t, "fake", faketest.QRFlowID)
	r := e.start(faketest.QRFlowID)
	if r.Step.Type != bridgev2.LoginStepTypeDisplayAndWait || r.Step.DisplayAndWaitParams.Data != "qr-0" {
		t.Fatalf("start step = %+v; want display_and_wait showing qr-0", r.Step)
	}
	waitFor(t, "three login step events", func() bool { return len(e.pushes.forProcess(r.ProcessID)) == 3 })
	evs := e.pushes.forProcess(r.ProcessID)
	if evs[0].Step.DisplayAndWaitParams.Data != "qr-1" || evs[1].Step.DisplayAndWaitParams.Data != "qr-2" {
		t.Errorf("refreshes = %q, %q; want qr-1, qr-2", evs[0].Step.DisplayAndWaitParams.Data, evs[1].Step.DisplayAndWaitParams.Data)
	}
	if evs[2].Step.Type != bridgev2.LoginStepTypeComplete {
		t.Errorf("last event step = %+v; want complete", evs[2].Step)
	}
	if !(r.Seq < evs[0].Seq && evs[0].Seq < evs[1].Seq && evs[1].Seq < evs[2].Seq) {
		t.Errorf("seqs = %d, %d, %d, %d; want strictly increasing", r.Seq, evs[0].Seq, evs[1].Seq, evs[2].Seq)
	}
	for _, ev := range evs {
		if ev.Error != nil {
			t.Errorf("event %+v carries an error", ev)
		}
	}
	if a := e.accounts(); len(a) != 1 || a[0].LoginID != faketest.QRUser {
		t.Errorf("accounts = %+v; want the QR login", a)
	}
}

func TestLoginTimeoutThenRestart(t *testing.T) {
	e := newEnv(t, "fake", faketest.QRFlowID, faketest.QRTimeoutFlowID)
	r := e.start(faketest.QRTimeoutFlowID)
	waitFor(t, "the timeout event", func() bool { return len(e.pushes.forProcess(r.ProcessID)) == 1 })
	ev := e.pushes.forProcess(r.ProcessID)[0]
	if ev.Error == nil || ev.Error.Code != "FAKE_LOGIN_TIMEOUT" || ev.Error.Message == "" || ev.Step != nil {
		t.Fatalf("event = %+v; want only an error with code FAKE_LOGIN_TIMEOUT", ev)
	}
	waitFor(t, "the failed process to be cancelled", func() bool { return e.fake.LoginCancels() == 1 })
	_, err := e.m.Submit(context.Background(), SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID})
	wantCode(t, err, rpc.CodeNotFound)

	again := e.start(faketest.QRFlowID)
	if again.ProcessID == r.ProcessID {
		t.Errorf("restart reused process ID %s", again.ProcessID)
	}
	waitFor(t, "the restarted flow to complete", func() bool {
		evs := e.pushes.forProcess(again.ProcessID)
		return len(evs) == 3 && evs[2].Step.Type == bridgev2.LoginStepTypeComplete
	})
}

func TestFlowFilter(t *testing.T) {
	e := newEnv(t, "fake")
	ctx := context.Background()
	flows, err := e.m.Flows(ctx, "fake")
	if err != nil {
		t.Fatalf("flows: %v", err)
	}
	if len(flows) != 1 || flows[0].ID != "fake" || flows[0].Name == "" {
		t.Fatalf("flows = %+v; want only fake", flows)
	}
	_, err = e.m.Start(ctx, "fake", faketest.QRFlowID)
	wantCode(t, err, rpc.CodeInvalidInput)
	_, err = e.m.Start(ctx, "fake", "nonsense")
	wantCode(t, err, rpc.CodeInvalidInput)
	_, err = e.m.Flows(ctx, "nope")
	wantCode(t, err, rpc.CodeNotFound)
	_, err = e.m.Start(ctx, "nope", "fake")
	wantCode(t, err, rpc.CodeNotFound)
}

func TestLogout(t *testing.T) {
	e := newEnv(t, "fake")
	ctx := context.Background()
	r := e.start("fake")
	if _, err := e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID, Input: map[string]string{"username": "a"}}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if err := e.m.Logout(ctx, "", "a"); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if a := e.accounts(); len(a) != 0 {
		t.Errorf("accounts = %+v; want none after logout", a)
	}
	waitFor(t, "LOGGED_OUT account state", func() bool { return e.sink.has(status.StateLoggedOut) })
	wantCode(t, e.m.Logout(ctx, "", "a"), rpc.CodeNotFound)
	wantCode(t, e.m.Logout(ctx, "nope", "a"), rpc.CodeNotFound)
}

func TestAccountsEmptyIsNotNil(t *testing.T) {
	e := newEnv(t, "fake")
	if a := e.accounts(); a == nil || len(a) != 0 {
		t.Errorf("accounts = %#v; want an empty non-nil list", a)
	}
}

func TestSecondStartCancelsFirst(t *testing.T) {
	e := newEnv(t, "fake")
	ctx := context.Background()
	first := e.start("fake")
	second := e.start("fake")
	_, err := e.m.Submit(ctx, SubmitParams{ProcessID: first.ProcessID, StepID: first.Step.StepID, Input: map[string]string{"username": "a"}})
	wantCode(t, err, rpc.CodeNotFound)
	if _, err := e.m.Submit(ctx, SubmitParams{ProcessID: second.ProcessID, StepID: second.Step.StepID, Input: map[string]string{"username": "b"}}); err != nil {
		t.Fatalf("submit on the second process: %v", err)
	}
}

func TestCancel(t *testing.T) {
	e := newEnv(t, "fake")
	ctx := context.Background()
	r := e.start("fake")
	if err := e.m.Cancel(r.ProcessID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	_, err := e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID, Input: map[string]string{"username": "a"}})
	wantCode(t, err, rpc.CodeNotFound)
	wantCode(t, e.m.Cancel(r.ProcessID), rpc.CodeNotFound)
	// Starting works again.
	e.start("fake")
}

func TestSubmitValidation(t *testing.T) {
	e := newEnv(t, "fake")
	ctx := context.Background()
	r := e.start("fake")
	_, err := e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: "some.other.step", Input: map[string]string{"username": "a"}})
	wantCode(t, err, rpc.CodeInvalidInput)
	// A mismatch does not end the process.
	if _, err := e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID, Input: map[string]string{"username": "a"}}); err != nil {
		t.Fatalf("submit after a rejected one: %v", err)
	}
	// Cookies to a user_input step.
	r2 := e.start("fake")
	_, err = e.m.Submit(ctx, SubmitParams{ProcessID: r2.ProcessID, StepID: r2.Step.StepID, Cookies: map[string]string{"c": "v"}})
	wantCode(t, err, rpc.CodeInvalidInput)
}

func TestSubmitFailureEndsProcessAndKeepsSecretsOutOfLogs(t *testing.T) {
	e := newEnv(t, "fake")
	ctx := context.Background()
	r := e.start("fake")
	// The fake rejects an empty username; the password must go nowhere.
	_, err := e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID,
		Input: map[string]string{"username": "", "password": "hunter2-secret"}})
	wantCode(t, err, CodeLoginFailed)
	if strings.Contains(err.Error(), "hunter2-secret") || strings.Contains(e.logs.String(), "hunter2-secret") {
		t.Errorf("secret leaked into error %q or logs %q", err, e.logs.String())
	}
	_, err = e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID, Input: map[string]string{"username": "a"}})
	wantCode(t, err, rpc.CodeNotFound)
}

func TestIdleExpiry(t *testing.T) {
	e := newEnv(t, "fake")
	e.m.IdleTimeout = 30 * time.Millisecond
	r := e.start("fake")
	waitFor(t, "the expiry event", func() bool { return len(e.pushes.forProcess(r.ProcessID)) == 1 })
	if ev := e.pushes.forProcess(r.ProcessID)[0]; ev.Error == nil || ev.Error.Code != CodeLoginExpired {
		t.Fatalf("event = %+v; want error %s", ev, CodeLoginExpired)
	}
	_, err := e.m.Submit(context.Background(), SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID, Input: map[string]string{"username": "a"}})
	wantCode(t, err, rpc.CodeNotFound)
	e.start("fake")
}

func TestActivityDefersExpiry(t *testing.T) {
	e := newEnv(t, "fake")
	e.m.IdleTimeout = 300 * time.Millisecond
	ctx := context.Background()
	r := e.start("fake")
	// A rejected submit still counts as activity; keep the process busy for
	// longer than one idle period.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		_, err := e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: "wrong"})
		wantCode(t, err, rpc.CodeInvalidInput)
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := e.m.Submit(ctx, SubmitParams{ProcessID: r.ProcessID, StepID: r.Step.StepID, Input: map[string]string{"username": "a"}}); err != nil {
		t.Fatalf("submit after activity: %v", err)
	}
}
