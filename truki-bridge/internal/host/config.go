// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package host

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/bridgeconfig"
	"maunium.net/go/mautrix/event"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/trukiconnector"
)

// bridgeConfig returns the bridgev2 config for one network. Values follow
// mautrix's example config (bridgev2/matrix/mxmain/example-config.yaml)
// except where Truki differs; each difference is commented.
func bridgeConfig(network, commandPrefix string) *bridgeconfig.BridgeConfig {
	return &bridgeconfig.BridgeConfig{
		// bridgev2 runs any message starting with the prefix as a bridge
		// command (logout, delete-portal...) and reports it as sent. Truki
		// has no command UI, so the prefix is one no user text can carry.
		CommandPrefix: commandPrefix,
		// Spaces are a homeserver-client concept; Truki has its own.
		PersonalFilteringSpaces: false,
		PrivateChatPortalMeta:   true,
		// "none": bridge-state notices would create a management room (a
		// chat with the bridge bot). Truki gets bridge states through
		// SendBridgeStatus instead.
		BridgeStatusNotices:           "none",
		UnknownErrorMaxAutoReconnects: 10,
		TagOnlyOnCreate:               true,
		OnlyBridgeTags:                []event.RoomTag{event.RoomTagFavourite, event.RoomTagLowPriority},
		MuteOnlyOnCreate:              true,
		PortalEventBuffer:             64,
		KickMatrixUsers:               true,
		// Truki stores the event under the ID it was sent with; re-IDing
		// outgoing messages would orphan the stored row.
		OutgoingMessageReID: false,
		PortalCreateFilter:  bridgeconfig.PortalCreateFilter{Mode: bridgeconfig.PortalCreateFilterModeDeny},
		// The local user is the only Matrix user: admin, owner of all logins.
		Permissions: bridgeconfig.PermissionConfig{
			string(trukiconnector.LocalUser): &bridgeconfig.PermissionLevelAdmin,
		},
		// Example defaults, but enabled: Truki keeps history locally.
		Backfill: bridgeconfig.BackfillConfig{
			Enabled:              true,
			MaxInitialMessages:   50,
			MaxCatchupMessages:   500,
			UnreadHoursThreshold: 720,
			Threads:              bridgeconfig.BackfillThreadsConfig{MaxInitialMessages: 50},
			Queue: bridgeconfig.BackfillQueueConfig{
				Enabled:    true,
				BatchSize:  100,
				BatchDelay: 20,
				MaxBatches: maxBackfillBatches(network),
			},
		},
	}
}

// maxBackfillBatches caps how many backward-backfill batches the queue
// fetches per chat (-1: no cap, as in the example config). Meta and
// Instagram fetch history from servers that flag aggressive clients, so
// their backfill stops after a few batches; WhatsApp gets its history pushed
// by the phone and keeps the default.
func maxBackfillBatches(network string) int {
	switch network {
	case "meta", "instagram":
		return 5
	default:
		return -1
	}
}

// stripTemplatedLines drops lines whose value is a mautrix config template
// ($<<...>>), which only mxmain's example-config renderer understands.
func stripTemplatedLines(example string) string {
	lines := strings.SplitAfter(example, "\n")
	out := lines[:0]
	for _, line := range lines {
		if !strings.Contains(line, "$<<") {
			out = append(out, line)
		}
	}
	return strings.Join(out, "")
}

// loadNetworkConfig fills the connector's config from its own example, as
// mxmain does for a fresh config file, and validates it when the connector
// supports that.
func loadNetworkConfig(nc bridgev2.NetworkConnector) error {
	example, data, _ := nc.GetConfig()
	if data != nil && example != "" {
		if err := yaml.Unmarshal([]byte(stripTemplatedLines(example)), data); err != nil {
			return fmt.Errorf("failed to parse network config example: %w", err)
		}
	}
	if v, ok := nc.(bridgev2.ConfigValidatingNetwork); ok {
		if err := v.ValidateConfig(); err != nil {
			return fmt.Errorf("invalid network config: %w", err)
		}
	}
	return nil
}
