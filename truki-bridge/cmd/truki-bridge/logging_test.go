// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// TestLogLevel checks that debug logs are dropped unless a developer sets
// TRUKI_BRIDGE_LOG_LEVEL=debug, for the process logger, loggers derived from
// it (as bridgev2 does) and the whatsmeow adapter the connectors wrap them in.
func TestLogLevel(t *testing.T) {
	t.Cleanup(func() { zerolog.SetGlobalLevel(zerolog.TraceLevel) })

	for _, tc := range []struct {
		env       string
		wantDebug bool
	}{
		{"", false},
		{"info", false},
		{"trace", false},
		{"debug", true},
		{"DEBUG", true},
	} {
		t.Run("env="+tc.env, func(t *testing.T) {
			t.Setenv(logLevelEnv, tc.env)
			var out bytes.Buffer
			log := newLogger(&out)
			derived := log.With().Str("network", "whatsapp").Logger()
			wa := waLog.Zerolog(derived.With().Str("component", "whatsmeow").Logger())

			log.Debug().Msg("process-debug")
			derived.Debug().Msg("bridge-debug")
			wa.Debugf("whatsmeow-debug %s", "12345@s.whatsapp.net")
			// A logger created elsewhere at its own default level is still
			// capped by the global level.
			standalone := zerolog.New(&out)
			standalone.Debug().Msg("standalone-debug")
			log.Info().Msg("process-info")

			got := out.String()
			for _, line := range []string{"process-debug", "bridge-debug", "whatsmeow-debug", "standalone-debug"} {
				if strings.Contains(got, line) != tc.wantDebug {
					t.Errorf("%s logged = %v; want %v\n%s", line, !tc.wantDebug, tc.wantDebug, got)
				}
			}
			if !strings.Contains(got, "process-info") {
				t.Errorf("info line missing:\n%s", got)
			}
		})
	}
}
