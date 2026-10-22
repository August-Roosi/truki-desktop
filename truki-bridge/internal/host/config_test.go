// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package host

import (
	"testing"

	"go.mau.fi/mautrix-whatsapp/pkg/connector"
)

// Meta and Instagram stop backward backfill after 5 batches per chat;
// WhatsApp (and anything else) keeps the uncapped default.
func TestBackfillMaxBatchesPerNetwork(t *testing.T) {
	for network, want := range map[string]int{
		"meta":      5,
		"instagram": 5,
		"whatsapp":  -1,
		"fake":      -1,
	} {
		cfg := bridgeConfig(network, "!truki")
		if !cfg.Backfill.Enabled || !cfg.Backfill.Queue.Enabled {
			t.Errorf("%s: backfill disabled", network)
		}
		if got := cfg.Backfill.Queue.MaxBatches; got != want {
			t.Errorf("%s: MaxBatches = %d; want %d", network, got, want)
		}
	}
}

// WhatsApp shows up as "Trüki" in the phone's Linked devices, display names
// carry no " (WA)" suffix and status broadcast is off. Other keys keep the
// example's values.
func TestWhatsAppConfigOverrides(t *testing.T) {
	nc := &connector.WhatsAppConnector{}
	if err := loadNetworkConfig("whatsapp", nc); err != nil {
		t.Fatal(err)
	}
	_, data, _ := nc.GetConfig()
	cfg := data.(*connector.Config)
	if cfg.OSName != "Trüki" {
		t.Errorf("OSName = %q", cfg.OSName)
	}
	if cfg.BrowserName != "unknown" {
		t.Errorf("BrowserName = %q", cfg.BrowserName)
	}
	if want := `{{or .BusinessName .PushName .Phone .RedactedPhone "Unknown user"}}`; cfg.DisplaynameTemplate != want {
		t.Errorf("DisplaynameTemplate = %q", cfg.DisplaynameTemplate)
	}
	if cfg.EnableStatusBroadcast {
		t.Error("EnableStatusBroadcast = true")
	}
}

// Without an override entry the example's values stand.
func TestOtherNetworkConfigKeepsExample(t *testing.T) {
	nc := &connector.WhatsAppConnector{}
	if err := loadNetworkConfig("fake", nc); err != nil {
		t.Fatal(err)
	}
	_, data, _ := nc.GetConfig()
	cfg := data.(*connector.Config)
	if cfg.OSName != "Mautrix-WhatsApp bridge" || !cfg.EnableStatusBroadcast {
		t.Errorf("example values changed: %q %v", cfg.OSName, cfg.EnableStatusBroadcast)
	}
}
