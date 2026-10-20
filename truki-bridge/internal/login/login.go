// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Package login drives bridgev2 login processes and account management for
// the RPC API. It mirrors bridgev2's provisioning API (bridgev2/matrix
// provisioninglogin.go): a process is created per start, steps are submitted
// against the current step's ID, display_and_wait steps are followed by
// calling Wait, any error ends and cancels the process, and a completed
// process is dropped without being cancelled.
//
// Login secrets (passwords, cookies, tokens) pass through Submit only; they
// are never logged and never put into error messages by this package.
package login

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/rpc"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/trukiconnector"
)

// Error codes of this package, besides the generic rpc ones.
const (
	// CodeLoginFailed marks a login process the network failed. The process
	// is gone; the caller starts a new one.
	CodeLoginFailed = "LOGIN_FAILED"
	// CodeLoginExpired is pushed (as event.login.step error) when a process
	// is dropped after IdleTimeout without a submit.
	CodeLoginExpired = "LOGIN_EXPIRED"
)

// DefaultIdleTimeout is how long a process may sit without a start or
// submit before it is cancelled.
const DefaultIdleTimeout = 10 * time.Minute

// Bridges is the part of the host the manager needs.
type Bridges interface {
	Defs() []host.NetworkDef
	Bridge(ctx context.Context, network string) (*bridgev2.Bridge, error)
	RunningBridge(network string) (*bridgev2.Bridge, bool)
	AccountState(network string, login networkid.UserLoginID) string
}

// StepResult is a login step and its position in the process. Seq grows by
// one with every step of a process, so a client that receives a step both
// as a result and as an event keeps the one with the higher Seq.
type StepResult struct {
	ProcessID string              `json:"processId,omitempty"`
	Step      *bridgev2.LoginStep `json:"step"`
	Seq       int                 `json:"seq"`
}

// StepEvent is the params of event.login.step: either the next step of a
// display_and_wait process or the error that ended it.
type StepEvent struct {
	ProcessID string              `json:"processId"`
	Step      *bridgev2.LoginStep `json:"step,omitempty"`
	Seq       int                 `json:"seq,omitempty"`
	Error     *EventError         `json:"error,omitempty"`
}

// EventError is the error of a StepEvent.
type EventError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// SubmitParams is login.submit's input. Input answers a user_input step and
// Cookies a cookies step.
type SubmitParams struct {
	ProcessID string
	StepID    string
	Input     map[string]string
	Cookies   map[string]string
}

// Account is one login of the local user.
type Account struct {
	LoginID    string `json:"loginId"`
	Network    string `json:"network"`
	RemoteName string `json:"remoteName"`
	State      string `json:"state"`
}

// Manager owns the in-flight login processes.
type Manager struct {
	// IdleTimeout overrides DefaultIdleTimeout; set it before first use.
	IdleTimeout time.Duration

	bridges Bridges
	notify  func(method string, params any)
	log     zerolog.Logger

	mu        sync.Mutex
	processes map[string]*process
	byNetwork map[string]*process
}

// NewManager returns a manager that pushes event.login.step through notify.
func NewManager(bridges Bridges, notify func(method string, params any), log zerolog.Logger) *Manager {
	return &Manager{
		IdleTimeout: DefaultIdleTimeout,
		bridges:     bridges,
		notify:      notify,
		log:         log,
		processes:   make(map[string]*process),
		byNetwork:   make(map[string]*process),
	}
}

type process struct {
	id      string
	network string
	proc    bridgev2.LoginProcess
	ctx     context.Context
	cancel  context.CancelFunc
	idle    *time.Timer

	// mu serialises start, submit and settling a step. It is not held
	// while a display_and_wait Wait runs.
	mu   sync.Mutex
	step *bridgev2.LoginStep
	seq  int
	done bool // guarded by Manager.mu
}

func randomID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (m *Manager) def(network string) (host.NetworkDef, error) {
	for _, d := range m.bridges.Defs() {
		if d.ID == network {
			return d, nil
		}
	}
	return host.NetworkDef{}, rpc.Errf(rpc.CodeNotFound, "unknown network %q", network)
}

// Flows lists the login flows of network that its definition allows.
func (m *Manager) Flows(ctx context.Context, network string) ([]bridgev2.LoginFlow, error) {
	d, err := m.def(network)
	if err != nil {
		return nil, err
	}
	br, err := m.bridges.Bridge(ctx, network)
	if err != nil {
		return nil, err
	}
	flows := []bridgev2.LoginFlow{}
	for _, f := range br.Network.GetLoginFlows() {
		if slices.Contains(d.Flows, f.ID) {
			flows = append(flows, f)
		}
	}
	return flows, nil
}

// Start begins a login on network with flowID and returns the first step.
// A network has at most one process: an earlier one still in flight is
// cancelled (the user abandoned that dialog without cancelling it).
func (m *Manager) Start(ctx context.Context, network, flowID string) (*StepResult, error) {
	flows, err := m.Flows(ctx, network)
	if err != nil {
		return nil, err
	}
	if !slices.ContainsFunc(flows, func(f bridgev2.LoginFlow) bool { return f.ID == flowID }) {
		return nil, rpc.Errf(rpc.CodeInvalidInput, "network %q has no login flow %q", network, flowID)
	}
	br, err := m.bridges.Bridge(ctx, network)
	if err != nil {
		return nil, err
	}
	user, err := br.GetUserByMXID(ctx, trukiconnector.LocalUser)
	if err != nil {
		return nil, fmt.Errorf("failed to get the local user: %w", err)
	}
	lp, err := br.Network.CreateLogin(ctx, user, flowID)
	if err != nil {
		return nil, rpc.Errf(CodeLoginFailed, "failed to create the login process: %v", err)
	}

	pctx, cancel := context.WithCancel(br.BackgroundCtx)
	pr := &process{id: randomID(), network: network, proc: lp, ctx: pctx, cancel: cancel}
	pr.mu.Lock()
	defer pr.mu.Unlock()

	m.mu.Lock()
	old := m.byNetwork[network]
	m.processes[pr.id] = pr
	m.byNetwork[network] = pr
	m.touchLocked(pr)
	m.mu.Unlock()
	if old != nil {
		m.log.Info().Str("network", network).Msg("Cancelling the earlier login process")
		m.end(old, true)
	}

	var step *bridgev2.LoginStep
	if paramable, ok := lp.(bridgev2.LoginProcessWithParams); ok {
		step, err = paramable.StartWithParams(pctx, bridgev2.LoginStartParams{})
	} else {
		step, err = lp.Start(pctx)
	}
	res, err := m.settle(pr, step, err)
	if err != nil {
		return nil, err
	}
	res.ProcessID = pr.id
	m.log.Info().Str("network", network).Str("flow", flowID).Str("process", pr.id).Msg("Started login process")
	return res, nil
}

// Submit answers the current step of a process.
func (m *Manager) Submit(ctx context.Context, p SubmitParams) (*StepResult, error) {
	pr, err := m.lookup(p.ProcessID)
	if err != nil {
		return nil, err
	}
	pr.mu.Lock()
	defer pr.mu.Unlock()
	m.mu.Lock()
	if pr.done {
		m.mu.Unlock()
		return nil, rpc.Errf(rpc.CodeNotFound, "login process %q not found", p.ProcessID)
	}
	m.touchLocked(pr)
	m.mu.Unlock()

	if pr.step == nil || pr.step.StepID != p.StepID {
		return nil, rpc.Errf(rpc.CodeInvalidInput, "stepId does not match the current step")
	}
	var (
		step *bridgev2.LoginStep
		cerr error
	)
	switch pr.step.Type {
	case bridgev2.LoginStepTypeUserInput:
		up, ok := pr.proc.(bridgev2.LoginProcessUserInput)
		if !ok || p.Cookies != nil {
			return nil, rpc.Errf(rpc.CodeInvalidInput, "the current step takes input, not cookies")
		}
		step, cerr = up.SubmitUserInput(pr.ctx, p.Input)
	case bridgev2.LoginStepTypeCookies:
		cp, ok := pr.proc.(bridgev2.LoginProcessCookies)
		if !ok || p.Input != nil {
			return nil, rpc.Errf(rpc.CodeInvalidInput, "the current step takes cookies, not input")
		}
		step, cerr = cp.SubmitCookies(pr.ctx, p.Cookies)
	default:
		return nil, rpc.Errf(rpc.CodeInvalidInput, "the current step (%s) cannot be submitted", pr.step.Type)
	}
	return m.settle(pr, step, cerr)
}

// Cancel abandons a process.
func (m *Manager) Cancel(processID string) error {
	pr, err := m.lookup(processID)
	if err != nil {
		return err
	}
	m.end(pr, true)
	return nil
}

func (m *Manager) lookup(processID string) (*process, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	pr, ok := m.processes[processID]
	if !ok {
		return nil, rpc.Errf(rpc.CodeNotFound, "login process %q not found", processID)
	}
	return pr, nil
}

// touchLocked (re)arms the idle timer. Must hold m.mu.
func (m *Manager) touchLocked(pr *process) {
	if pr.idle != nil {
		pr.idle.Stop()
	}
	pr.idle = time.AfterFunc(m.IdleTimeout, func() {
		if m.end(pr, true) {
			m.log.Info().Str("network", pr.network).Str("process", pr.id).Msg("Login process expired")
			m.notify("event.login.step", StepEvent{ProcessID: pr.id,
				Error: &EventError{Code: CodeLoginExpired, Message: "The login timed out"}})
		}
	})
}

// end drops a process; cancel also cancels it at the network (as
// provisioning does for every ending but completion). It reports whether
// this call ended the process.
func (m *Manager) end(pr *process, cancel bool) bool {
	m.mu.Lock()
	if pr.done {
		m.mu.Unlock()
		return false
	}
	pr.done = true
	delete(m.processes, pr.id)
	if m.byNetwork[pr.network] == pr {
		delete(m.byNetwork, pr.network)
	}
	if pr.idle != nil {
		pr.idle.Stop()
	}
	m.mu.Unlock()
	pr.cancel()
	if cancel {
		pr.proc.Cancel()
	}
	return true
}

// settle turns the outcome of Start, SubmitX or Wait into the process's
// next step. Must hold pr.mu (or be the process's only user, as the waiter
// is between steps).
func (m *Manager) settle(pr *process, step *bridgev2.LoginStep, err error) (*StepResult, error) {
	if err == nil && step == nil {
		err = errors.New("the network returned no login step")
	}
	if err == nil {
		switch step.Type {
		case bridgev2.LoginStepTypeUserInput, bridgev2.LoginStepTypeCookies,
			bridgev2.LoginStepTypeDisplayAndWait, bridgev2.LoginStepTypeComplete:
		default:
			err = fmt.Errorf("unsupported login step type %q", step.Type)
		}
	}
	if err != nil {
		m.end(pr, true)
		// The error text is not logged: it is the network's and may quote
		// what the user typed.
		m.log.Warn().Str("network", pr.network).Str("process", pr.id).Msg("Login process failed")
		return nil, &rpc.Error{Code: CodeLoginFailed, Message: err.Error()}
	}
	step.TxnID = "bls_" + randomID()
	pr.step = step
	pr.seq++
	res := &StepResult{Step: step, Seq: pr.seq}
	switch step.Type {
	case bridgev2.LoginStepTypeComplete:
		m.end(pr, false)
	case bridgev2.LoginStepTypeDisplayAndWait:
		if _, ok := pr.proc.(bridgev2.LoginProcessDisplayAndWait); ok {
			go m.follow(pr)
		} else {
			m.end(pr, true)
			return nil, rpc.Errf(CodeLoginFailed, "the network cannot wait for a %s step", step.Type)
		}
	}
	return res, nil
}

// follow calls Wait for a display_and_wait step and pushes what comes back:
// the next step, or the error that ended the process. A display_and_wait
// step in the answer is followed by settle starting the next follower.
func (m *Manager) follow(pr *process) {
	step, err := pr.proc.(bridgev2.LoginProcessDisplayAndWait).Wait(pr.ctx)
	if pr.ctx.Err() != nil {
		return // cancelled, completed or expired: nobody is waiting
	}
	pr.mu.Lock()
	res, serr := m.settle(pr, step, err)
	pr.mu.Unlock()
	if serr != nil {
		ev := StepEvent{ProcessID: pr.id, Error: &EventError{Code: CodeLoginFailed, Message: serr.Error()}}
		var re *rpc.Error
		if errors.As(serr, &re) {
			ev.Error.Message = re.Message
		}
		var br bridgev2.RespError
		if errors.As(err, &br) && br.ErrCode != "" {
			ev.Error.Code = br.ErrCode
		}
		m.notify("event.login.step", ev)
		return
	}
	m.notify("event.login.step", StepEvent{ProcessID: pr.id, Step: res.Step, Seq: res.Seq})
}

// Accounts lists the logins of the local user on every running network.
func (m *Manager) Accounts(ctx context.Context) ([]Account, error) {
	out := []Account{}
	for _, d := range m.bridges.Defs() {
		br, ok := m.bridges.RunningBridge(d.ID)
		if !ok {
			continue
		}
		user, err := br.GetUserByMXID(ctx, trukiconnector.LocalUser)
		if err != nil {
			return nil, fmt.Errorf("failed to get the local user: %w", err)
		}
		logins := user.GetUserLogins()
		slices.SortFunc(logins, func(a, b *bridgev2.UserLogin) int {
			switch {
			case a.ID < b.ID:
				return -1
			case a.ID > b.ID:
				return 1
			}
			return 0
		})
		for _, ul := range logins {
			s := m.bridges.AccountState(d.ID, ul.ID)
			if s == "" {
				s = "UNKNOWN"
			}
			out = append(out, Account{LoginID: string(ul.ID), Network: d.ID, RemoteName: ul.RemoteName, State: s})
		}
	}
	return out, nil
}

// Logout logs loginID out, remotely too, and removes it. network may be
// empty when loginID is unambiguous.
func (m *Manager) Logout(ctx context.Context, network, loginID string) error {
	var found []*bridgev2.UserLogin
	for _, d := range m.bridges.Defs() {
		if network != "" && d.ID != network {
			continue
		}
		br, ok := m.bridges.RunningBridge(d.ID)
		if !ok {
			continue
		}
		if ul := br.GetCachedUserLoginByID(networkid.UserLoginID(loginID)); ul != nil && ul.UserMXID == trukiconnector.LocalUser {
			found = append(found, ul)
		}
	}
	switch len(found) {
	case 0:
		return rpc.Errf(rpc.CodeNotFound, "login %q not found", loginID)
	case 1:
		found[0].Logout(ctx)
		return nil
	}
	return rpc.Errf(rpc.CodeInvalidInput, "login %q exists on several networks; name the network", loginID)
}
