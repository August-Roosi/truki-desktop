// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !faketest

package networks

import "github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"

// registry has no networks yet; the real connectors arrive with their own
// task.
func registry() []host.NetworkDef {
	return nil
}
