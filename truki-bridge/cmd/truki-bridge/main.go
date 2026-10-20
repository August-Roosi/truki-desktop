// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Command truki-bridge is the Truki messaging bridge.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/rs/zerolog"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/rpc"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// Version is set at build time with -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	version := flag.Bool("version", false, "print version and exit")
	selftest := flag.String("selftest-db", "", "(hidden) run SQLCipher store self-test in `dir` and exit")
	printStdout := flag.Bool("test-print-stdout", false,
		"(hidden) print a stray stdout line, then serve RPC")
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
	case *printStdout:
		fmt.Println("GARBAGE: stray stdout write before the RPC stream starts")
		if err := serve(); err != nil {
			fmt.Fprintln(os.Stderr, "serve:", err)
			os.Exit(1)
		}
	default:
		flag.Usage()
		os.Exit(2)
	}
}

// serve guards stdout, redirects the process's own stdout to stderr and
// serves RPC on the guarded handle until stdin reaches EOF.
func serve() error {
	rpcOut, err := dupStdout()
	if err != nil {
		return err
	}
	if err := redirectStdoutToStderr(); err != nil {
		return err
	}
	os.Stdout = os.Stderr

	log := zerolog.New(os.Stderr).With().Timestamp().Logger()
	conn := rpc.NewConn(os.Stdin, rpcOut, log)
	conn.HandleInit(func(ctx context.Context, p rpc.InitParams) (*rpc.InitResult, error) {
		return &rpc.InitResult{
			ProtocolVersion: rpc.ProtocolVersion,
			BridgeVersion:   Version,
			Networks:        []rpc.NetworkInfo{},
		}, nil
	})
	return conn.Serve(context.Background())
}
