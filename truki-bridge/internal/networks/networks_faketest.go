// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

//go:build faketest

package networks

import (
	"maunium.net/go/mautrix/bridgev2"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/faketest"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"
)

// registry serves the fake network, for binary-level tests built with
// -tags faketest.
func registry() []host.NetworkDef {
	return []host.NetworkDef{{
		ID:   "fake",
		Name: "Fake",
		New:  func() bridgev2.NetworkConnector { return faketest.NewFakeNetwork() },
		Flows: []string{
			faketest.FlowID,
			faketest.QRFlowID,
			faketest.QRTimeoutFlowID,
		},
	}}
}
