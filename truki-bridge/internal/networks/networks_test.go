// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !faketest

package networks

import (
	"bytes"
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/rs/zerolog"
	meta "go.mau.fi/mautrix-meta/pkg/connector"
	"go.mau.fi/mautrix-meta/pkg/igconnector"
	wa "go.mau.fi/mautrix-whatsapp/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

func TestAllNetworks(t *testing.T) {
	defs := All()
	var ids []string
	for _, d := range defs {
		ids = append(ids, d.ID)
	}
	if want := []string{"whatsapp", "meta", "instagram"}; !slices.Equal(ids, want) {
		t.Fatalf("All() IDs = %v; want %v", ids, want)
	}
	wantNames := []string{"WhatsApp", "Facebook Messenger", "Instagram"}
	wantFlows := [][]string{{"qr", "phone"}, {"facebook", "messenger"}, {"instagram"}}
	for i, d := range defs {
		if d.Name != wantNames[i] {
			t.Errorf("%s: name %q; want %q", d.ID, d.Name, wantNames[i])
		}
		if !slices.Equal(d.Flows, wantFlows[i]) {
			t.Errorf("%s: flows %v; want %v", d.ID, d.Flows, wantFlows[i])
		}
		nc := d.New()
		if nc == nil {
			t.Fatalf("%s: New() = nil", d.ID)
		}
		var have []string
		for _, f := range nc.GetLoginFlows() {
			have = append(have, f.ID)
		}
		for _, f := range d.Flows {
			if !slices.Contains(have, f) {
				t.Errorf("%s: connector flows %v lack %q", d.ID, have, f)
			}
		}
	}
	// Instagram is its own connector, not the Messenger one.
	if _, ok := defs[2].New().(*igconnector.IGConnector); !ok {
		t.Errorf("instagram connector is %T; want *igconnector.IGConnector", defs[2].New())
	}
}

type nopSink struct{}

func (nopSink) Message(*store.Event)                            {}
func (nopSink) Chat(*store.Chat)                                {}
func (nopSink) AccountState(string, status.BridgeState)         {}
func (nopSink) Notify(string, *bridgev2.DirectNotificationData) {}
func (nopSink) Typing(id.RoomID, []id.UserID)                   {}
func (nopSink) Receipt(id.RoomID, id.UserID, id.EventID)        {}

// TestRealNetworksStart starts every real connector's bridge on one
// SQLCipher database, twice (the second run must find the schemas current),
// without any login, so nothing connects to a network. Direct media and
// outgoing message re-ID stay off.
func TestRealNetworksStart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	key := bytes.Repeat([]byte{7}, 32)
	for run := 0; run < 2; run++ {
		db, err := store.Open(filepath.Join(dir, "truki-bridge.db"), key)
		if err != nil {
			t.Fatalf("run %d: open: %v", run, err)
		}
		st := store.New(db)
		if err := st.Upgrade(ctx); err != nil {
			t.Fatalf("run %d: upgrade: %v", run, err)
		}
		h := host.NewHost(db, st, dir, nopSink{}, All(), zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel))
		if err := h.Start(ctx); err != nil {
			t.Fatalf("run %d: start: %v", run, err)
		}
		for _, d := range All() {
			br, err := h.Bridge(ctx, d.ID)
			if err != nil {
				t.Fatalf("run %d: %s bridge: %v", run, d.ID, err)
			}
			if br.Config.OutgoingMessageReID {
				t.Errorf("%s: outgoing message re-ID enabled", d.ID)
			}
			var direct bool
			switch nc := br.Network.(type) {
			case *wa.WhatsAppConnector:
				direct = nc.MsgConv.DirectMedia
			case *meta.MetaConnector:
				direct = nc.MsgConv.DirectMedia
			case *igconnector.IGConnector:
				direct = nc.MsgConv.DirectMedia
			default:
				t.Fatalf("%s: unexpected connector %T", d.ID, nc)
			}
			if direct {
				t.Errorf("%s: direct media enabled", d.ID)
			}
		}
		h.Stop()
		_ = db.Close()
	}
}
