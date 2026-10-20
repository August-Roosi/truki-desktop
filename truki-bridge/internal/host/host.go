// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Package host runs one bridgev2.Bridge per network connector, all sharing
// one database and Truki's local store in place of a Matrix homeserver.
package host

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/commands"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/trukiconnector"
)

// NetworkDef describes a network the host can run.
type NetworkDef struct {
	ID, Name string
	New      func() bridgev2.NetworkConnector
	Flows    []string // allowed login flow IDs
}

// bridgeVersionTable is bridgev2's own upgrade version table. It is the
// dbutil default, distinct from the store's "truki_version".
const bridgeVersionTable = "version"

// Host owns the bridges. A network's bridge is constructed and started on
// first use, or by Start when the network already has a login.
type Host struct {
	db       *dbutil.Database
	st       *store.Store
	mediaDir string
	sink     trukiconnector.Sink
	states   *stateTracker
	defs     []NetworkDef
	log      zerolog.Logger

	// commandPrefix is random per process and starts with a control
	// character, so no message text can start with it.
	commandPrefix string

	mu       sync.Mutex
	upgraded bool
	bridges  map[string]*bridgev2.Bridge
}

// NewHost returns a host for defs. db is the database store.Open returned
// (shared by the store and every bridge); the caller keeps ownership and
// closes it after Stop.
func NewHost(db *dbutil.Database, st *store.Store, dataDir string, sink trukiconnector.Sink, defs []NetworkDef, log zerolog.Logger) *Host {
	var rnd [8]byte
	_, _ = rand.Read(rnd[:])
	states := &stateTracker{Sink: sink, last: make(map[stateKey]string)}
	return &Host{
		commandPrefix: "\x00truki-" + hex.EncodeToString(rnd[:]),
		db:            db,
		st:            st,
		mediaDir:      filepath.Join(dataDir, "media"),
		sink:          states,
		states:        states,
		defs:          defs,
		log:           log,
		bridges:       make(map[string]*bridgev2.Bridge),
	}
}

// bridgeDB returns bridgev2's view of the shared database for network. Each
// call gets its own dbutil child, because database.New sets UpgradeTable on
// the handle it is given.
func (h *Host) bridgeDB(network string, mt database.MetaTypes) *database.Database {
	return database.New(networkid.BridgeID(network), mt, h.db.Child(bridgeVersionTable, nil, nil))
}

// upgradeLocked runs bridgev2's schema upgrades once. Every bridge is
// ExternallyManagedDB, so none of them upgrades (or closes) the database
// itself. Must hold h.mu.
func (h *Host) upgradeLocked(ctx context.Context) error {
	if h.upgraded {
		return nil
	}
	if err := h.bridgeDB("", database.MetaTypes{}).Upgrade(ctx); err != nil {
		return bridgev2.DBUpgradeError{Err: err, Section: "main"}
	}
	h.upgraded = true
	return nil
}

func (h *Host) def(network string) (NetworkDef, bool) {
	for _, d := range h.defs {
		if d.ID == network {
			return d, true
		}
	}
	return NetworkDef{}, false
}

// Start starts the bridges of the networks that have at least one login.
// The others start lazily through Bridge.
func (h *Host) Start(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.upgradeLocked(ctx); err != nil {
		return err
	}
	for _, d := range h.defs {
		users, err := h.bridgeDB(d.ID, database.MetaTypes{}).UserLogin.GetAllUserIDsWithLogins(ctx)
		if err != nil {
			return fmt.Errorf("failed to check %s logins: %w", d.ID, err)
		}
		if len(users) == 0 {
			continue
		}
		if _, err := h.bridgeLocked(ctx, d); err != nil {
			return err
		}
	}
	return nil
}

// Bridge returns the running bridge for network, constructing and starting
// it on first use.
func (h *Host) Bridge(ctx context.Context, network string) (*bridgev2.Bridge, error) {
	d, ok := h.def(network)
	if !ok {
		return nil, fmt.Errorf("unknown network %q", network)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.upgradeLocked(ctx); err != nil {
		return nil, err
	}
	return h.bridgeLocked(ctx, d)
}

func (h *Host) bridgeLocked(ctx context.Context, d NetworkDef) (*bridgev2.Bridge, error) {
	if br, ok := h.bridges[d.ID]; ok {
		return br, nil
	}
	nc := d.New()
	if err := loadNetworkConfig(nc); err != nil {
		return nil, fmt.Errorf("%s: %w", d.ID, err)
	}
	log := h.log.With().Str("network", d.ID).Logger()
	mx := trukiconnector.New(d.ID, h.st, h.mediaDir, h.sink)
	br := bridgev2.NewBridge(networkid.BridgeID(d.ID), h.db.Child(bridgeVersionTable, nil, nil), log,
		bridgeConfig(d.ID, h.commandPrefix), mx, nc, commands.NewProcessor)
	br.ExternallyManagedDB = true
	if err := startBridge(ctx, br); err != nil {
		br.Stop()
		return nil, fmt.Errorf("failed to start %s bridge: %w", d.ID, err)
	}
	h.bridges[d.ID] = br
	return br, nil
}

// startBridge is bridgev2.Bridge.Start with PostStart run synchronously, as
// mxmain does. Start runs it in a goroutine nothing waits for, which then
// races Stop and the caller closing the database.
func startBridge(ctx context.Context, br *bridgev2.Bridge) error {
	ctx = br.Log.WithContext(ctx)
	if err := br.StartConnectors(ctx); err != nil {
		return err
	}
	if err := br.StartLogins(ctx); err != nil {
		return err
	}
	br.PostStart(ctx)
	return nil
}

// Stop stops every running bridge. It does not close the database.
func (h *Host) Stop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for network, br := range h.bridges {
		br.Stop()
		delete(h.bridges, network)
	}
}
