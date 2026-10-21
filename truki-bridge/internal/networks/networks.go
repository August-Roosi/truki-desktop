// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Package networks lists the networks the bridge serves. The real network
// connectors arrive with their own task; tests build the bridge with
// -tags faketest to get the fake network instead.
package networks

import "github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"

// All returns the networks the bridge serves, in configuration order.
func All() []host.NetworkDef {
	return registry()
}
