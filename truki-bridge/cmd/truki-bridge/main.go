// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Command truki-bridge is the Truki messaging bridge.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// Version is set at build time with -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	version := flag.Bool("version", false, "print version and exit")
	selftest := flag.String("selftest-db", "", "(hidden) run SQLCipher store self-test in `dir` and exit")
	flag.Parse()

	switch {
	case *version:
		fmt.Printf("truki-bridge %s\n", Version)
	case *selftest != "":
		if err := store.SelfTest(*selftest); err != nil {
			fmt.Fprintln(os.Stderr, "selftest failed:", err)
			os.Exit(1)
		}
		fmt.Println("selftest ok")
	default:
		flag.Usage()
		os.Exit(2)
	}
}
