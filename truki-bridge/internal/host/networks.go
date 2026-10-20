// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package host

import (
	"sync"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/trukiconnector"
)

// Defs returns the networks the host can run, in configuration order.
func (h *Host) Defs() []NetworkDef {
	return append([]NetworkDef(nil), h.defs...)
}

// RunningBridge returns network's bridge if it has been started. A network
// whose bridge is not running has no logins: Start runs every network that
// has one, and a first login starts the bridge through Bridge.
func (h *Host) RunningBridge(network string) (*bridgev2.Bridge, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	br, ok := h.bridges[network]
	return br, ok
}

type stateKey struct {
	network string
	login   networkid.UserLoginID
}

// stateTracker passes every sink call through and remembers each login's
// latest bridge state. bridgev2's own UserLogin.BridgeState.GetPrev is read
// without synchronisation against the goroutine that updates it.
type stateTracker struct {
	trukiconnector.Sink

	mu   sync.Mutex
	last map[stateKey]string
}

func (t *stateTracker) AccountState(network string, st status.BridgeState) {
	t.mu.Lock()
	if st.StateEvent == status.StateLoggedOut {
		delete(t.last, stateKey{network, st.RemoteID})
	} else {
		t.last[stateKey{network, st.RemoteID}] = string(st.StateEvent)
	}
	t.mu.Unlock()
	t.Sink.AccountState(network, st)
}

// AccountState returns the latest bridge state reported for a login (for
// example CONNECTED), or "" when none has been reported yet.
func (h *Host) AccountState(network string, login networkid.UserLoginID) string {
	h.states.mu.Lock()
	defer h.states.mu.Unlock()
	return h.states.last[stateKey{network, login}]
}
