// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package host

import "testing"

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
