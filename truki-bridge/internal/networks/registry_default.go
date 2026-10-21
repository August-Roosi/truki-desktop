// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !faketest

package networks

import (
	metaconnector "go.mau.fi/mautrix-meta/pkg/connector"
	"go.mau.fi/mautrix-meta/pkg/igconnector"
	waconnector "go.mau.fi/mautrix-whatsapp/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"
)

// registry serves the real networks. Each connector is constructed the way
// its upstream command (cmd/mautrix-whatsapp, cmd/mautrix-meta,
// cmd/mautrix-instagram) constructs it: Facebook Messenger and Instagram are
// separate connectors, so neither needs a mode setting.
func registry() []host.NetworkDef {
	return []host.NetworkDef{{
		ID:    "whatsapp",
		Name:  "WhatsApp",
		New:   func() bridgev2.NetworkConnector { return &waconnector.WhatsAppConnector{} },
		Flows: []string{waconnector.LoginFlowIDQR, waconnector.LoginFlowIDPhone},
	}, {
		ID:    "meta",
		Name:  "Facebook Messenger",
		New:   func() bridgev2.NetworkConnector { return &metaconnector.MetaConnector{} },
		Flows: []string{metaconnector.FlowIDFacebookCookies, metaconnector.FlowIDMessengerCookies},
	}, {
		ID:    "instagram",
		Name:  "Instagram",
		New:   func() bridgev2.NetworkConnector { return &igconnector.IGConnector{} },
		Flows: []string{igconnector.FlowIDCookies},
	}}
}
