// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"io"
	"os"
	"strings"

	"github.com/rs/zerolog"
)

// logLevelEnv names the variable a developer sets to "debug" to get debug
// logs. Everything the bridge writes to stderr ends up in Signal's main log,
// which users upload with "Submit debug log", and debug logs carry contacts'
// network IDs, so the default is info.
const logLevelEnv = "TRUKI_BRIDGE_LOG_LEVEL"

// logLevel returns the level for the value of logLevelEnv.
func logLevel(env string) zerolog.Level {
	if strings.EqualFold(strings.TrimSpace(env), "debug") {
		return zerolog.DebugLevel
	}
	return zerolog.InfoLevel
}

// newLogger returns the process logger writing to w. It also sets zerolog's
// global level, which caps every logger in the process: the ones bridgev2
// derives from it and the whatsmeow adapters wrapping those.
func newLogger(w io.Writer) zerolog.Logger {
	level := logLevel(os.Getenv(logLevelEnv))
	zerolog.SetGlobalLevel(level)
	return zerolog.New(w).Level(level).With().Timestamp().Logger()
}
