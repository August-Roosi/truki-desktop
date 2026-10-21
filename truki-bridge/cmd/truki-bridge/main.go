// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Command truki-bridge is the Truki messaging bridge.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/api"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/networks"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/rpc"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// Version is set at build time with -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	version := flag.Bool("version", false, "print version and exit")
	selftest := flag.String("selftest-db", "", "(hidden) run SQLCipher store self-test in `dir` and exit")
	printStdout := flag.Bool("test-print-stdout", false,
		"(hidden) install the stdout guard, print stray stdout lines, then serve RPC")
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
		if err := serve(*printStdout); err != nil {
			fmt.Fprintln(os.Stderr, "serve:", err)
			os.Exit(1)
		}
	}
}

// Stray stdout lines --test-print-stdout prints after the guard is
// installed: through the os.Stdout variable and, on Unix, straight to file
// descriptor 1. Both must land on stderr, never on the RPC stream.
const (
	stdoutGarbageVar = "GARBAGE: stray write through the os.Stdout variable"
	stdoutGarbageFD1 = "GARBAGE: stray write to file descriptor 1"
)

// printStrayStdout mimics a library writing to stdout after the guard is
// installed. It exists only for the --test-print-stdout self-test.
func printStrayStdout() {
	fmt.Println(stdoutGarbageVar)
	if err := writeFD1(stdoutGarbageFD1 + "\n"); err != nil {
		fmt.Fprintf(os.Stderr, "fd 1 write: %v\n", err)
	}
}

// serve guards stdout, redirects the process's own stdout to stderr and
// serves RPC on the guarded handle until stdin reaches EOF, a shutdown
// request, or a fatal init. When noise is true it prints stray stdout
// lines first (used by TestStdoutGuard).
func serve(noise bool) error {
	rpcOut, err := dupStdout()
	if err != nil {
		return err
	}
	if err := redirectStdoutToStderr(); err != nil {
		return err
	}
	os.Stdout = os.Stderr

	if noise {
		printStrayStdout()
	}

	log := zerolog.New(os.Stderr).With().Timestamp().Logger()
	out := &exitWriter{w: rpcOut}
	conn := rpc.NewConn(os.Stdin, out, log)

	var (
		db *dbutil.Database
		h  *host.Host
	)
	conn.Handle("shutdown", func(context.Context, json.RawMessage) (any, error) {
		if h != nil {
			h.Stop()
		}
		if db != nil {
			_ = db.Close()
		}
		out.exitAfterFlush(0)
		return map[string]any{}, nil
	})
	conn.HandleInit(func(ctx context.Context, p rpc.InitParams) (*rpc.InitResult, error) {
		key, err := decodeDBKey(p.DBKey)
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Join(p.DataDir, "media"), 0o700); err != nil {
			return nil, rpc.Errf(rpc.CodeInternal, "create data dir: %v", err)
		}
		db, err = store.Open(filepath.Join(p.DataDir, "truki-bridge.db"), key)
		if err != nil {
			if errors.Is(err, store.ErrBadKey) {
				// The key never decrypts this database; retrying cannot
				// help, so the process exits as a crash after the reply.
				out.exitAfterFlush(1)
				return nil, rpc.Errf(rpc.CodeInternal, "bad key: the database key does not decrypt the database")
			}
			return nil, rpc.Errf(rpc.CodeInternal, "open database: %v", err)
		}
		st := store.New(db)
		if err := st.Upgrade(ctx); err != nil {
			_ = db.Close()
			db = nil
			return nil, rpc.Errf(rpc.CodeInternal, "upgrade database: %v", err)
		}
		// A pending send cannot survive a bridge restart: nothing would
		// ever report its final status.
		if _, err := st.FailPendingEvents(ctx); err != nil {
			_ = db.Close()
			db = nil
			return nil, rpc.Errf(rpc.CodeInternal, "fail pending events: %v", err)
		}
		defs := networks.All()
		h = host.NewHost(db, st, p.DataDir, api.NewSink(conn.Notify), defs, log)
		api.Register(conn, h, st)
		if err := h.Start(ctx); err != nil {
			h.Stop()
			_ = db.Close()
			h, db = nil, nil
			return nil, rpc.Errf(rpc.CodeInternal, "start bridges: %v", err)
		}
		nets := make([]rpc.NetworkInfo, 0, len(defs))
		for _, d := range defs {
			nets = append(nets, rpc.NetworkInfo{ID: d.ID, Name: d.Name})
		}
		return &rpc.InitResult{
			ProtocolVersion: rpc.ProtocolVersion,
			BridgeVersion:   Version,
			Networks:        nets,
		}, nil
	})
	return conn.Serve(context.Background())
}

// decodeDBKey decodes the init dbKey: 64 hex characters of raw SQLCipher
// key material. The key itself never appears in an error.
func decodeDBKey(s string) ([]byte, error) {
	if len(s) != 64 {
		return nil, rpc.Errf(rpc.CodeInvalidInput, "dbKey must be 64 hex characters")
	}
	key, err := hex.DecodeString(s)
	if err != nil {
		return nil, rpc.Errf(rpc.CodeInvalidInput, "dbKey must be 64 hex characters")
	}
	return key, nil
}

// exitWriter ends the process once the RPC message that asked for the exit
// has been written. The rpc layer writes each response directly after its
// handler returns, so exiting from Write guarantees the reply reached the
// pipe first. shutdown exits 0; an init with a bad database key exits 1,
// which the supervisor treats as a crash.
type exitWriter struct {
	w io.Writer

	mu      sync.Mutex
	pending bool
	status  int
}

// exitAfterFlush makes the process exit with status once the next RPC
// message has been written.
func (e *exitWriter) exitAfterFlush(status int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.pending = true
	e.status = status
}

func (e *exitWriter) Write(p []byte) (int, error) {
	n, err := e.w.Write(p)
	e.mu.Lock()
	pending, status := e.pending, e.status
	e.mu.Unlock()
	if err == nil && pending {
		os.Exit(status)
	}
	return n, err
}
