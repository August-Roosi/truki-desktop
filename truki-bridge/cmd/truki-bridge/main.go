// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Command truki-bridge is the Truki messaging bridge.
package main

import (
	"bytes"
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
	if len(os.Args) > 1 && os.Args[1] == "devcli" {
		os.Exit(devCLI(os.Args[2:]))
	}
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

	log := newLogger(os.Stderr)
	in := &idReader{r: os.Stdin}
	out := &exitWriter{w: rpcOut}
	conn := rpc.NewConn(in, out, log)

	var (
		db *dbutil.Database
		h  *host.Host
	)
	conn.Handle("shutdown", func(context.Context, json.RawMessage) (any, error) {
		id := in.takeShutdownID()
		if h != nil {
			h.Stop()
		}
		if db != nil {
			_ = db.Close()
		}
		out.exitAfterFlush(0, id)
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
				out.exitAfterFlush(1, in.initRequestID())
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

// exitWriter ends the process once the RPC response to the request that
// asked for the exit has been written. The rpc layer writes each response
// directly after its handler returns, and handlers run concurrently, so the
// exit must not fire on whatever line happens to be written next: it fires
// only when the written line is a JSON-RPC response whose id is the recorded
// one. A recorded nil id (a request with no id, so no response is ever
// coming) keeps exiting on the next write. shutdown exits 0; an init with a
// bad database key exits 1, which the supervisor treats as a crash.
type exitWriter struct {
	w io.Writer

	mu     sync.Mutex
	armed  bool
	status int
	exitID json.RawMessage
}

// exitAfterFlush makes the process exit with status once the response to the
// request with this id has been written.
func (e *exitWriter) exitAfterFlush(status int, id json.RawMessage) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.armed = true
	e.status = status
	e.exitID = append(json.RawMessage(nil), bytes.TrimSpace(id)...)
}

func (e *exitWriter) Write(p []byte) (int, error) {
	n, err := e.w.Write(p)
	if err == nil {
		if exit, status := e.exitOn(p); exit {
			os.Exit(status)
		}
	}
	return n, err
}

// exitOn reports whether the written line is the response the exit is armed
// for, and the status to exit with.
func (e *exitWriter) exitOn(line []byte) (bool, int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.armed {
		return false, 0
	}
	if len(e.exitID) == 0 {
		return true, e.status
	}
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	// A response carries an id and no method; a notification the other way.
	if json.Unmarshal(bytes.TrimSpace(line), &msg) != nil || msg.Method != "" || len(msg.ID) == 0 {
		return false, 0
	}
	return bytes.Equal(e.exitID, bytes.TrimSpace(msg.ID)), e.status
}

// maxTrackedLine caps the line idReader assembles: anything longer is
// dropped instead of buffered.
const maxTrackedLine = 1 << 20

// idReader tracks the ids of incoming init and shutdown requests. The rpc
// package does not hand a handler its request id, but the exit machinery
// needs it: the process must exit on the response to the request that asked
// for the exit, not on whichever line is written next.
type idReader struct {
	r io.Reader

	mu          sync.Mutex
	line        []byte
	dropped     bool
	initID      json.RawMessage
	shutdownIDs []json.RawMessage
}

func (r *idReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if n > 0 {
		r.scan(p[:n])
	}
	return n, err
}

// scan inspects a read chunk for complete lines. Lines are assembled across
// reads; an oversized line is discarded whole.
func (r *idReader) scan(chunk []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for len(chunk) > 0 {
		i := bytes.IndexByte(chunk, '\n')
		var piece []byte
		if i < 0 {
			piece, chunk = chunk, nil
		} else {
			piece, chunk = chunk[:i], chunk[i+1:]
		}
		if r.dropped {
			if i >= 0 {
				r.dropped = false
			}
			continue
		}
		r.line = append(r.line, piece...)
		if i < 0 {
			if len(r.line) > maxTrackedLine {
				r.line, r.dropped = nil, true
			}
			return
		}
		r.note(r.line)
		r.line = r.line[:0]
	}
}

// note records the id of one complete init or shutdown request line.
func (r *idReader) note(line []byte) {
	var req struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &req) != nil || req.Method == "" {
		return
	}
	id := append(json.RawMessage(nil), bytes.TrimSpace(req.ID)...)
	switch req.Method {
	case "init":
		r.initID = id
	case "shutdown":
		r.shutdownIDs = append(r.shutdownIDs, id)
	}
}

// initRequestID returns the id of the last init request read. init is served
// synchronously, so that is the one being handled.
func (r *idReader) initRequestID() json.RawMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.initID
}

// takeShutdownID returns the id of the next shutdown request, in the order
// they were read.
func (r *idReader) takeShutdownID() json.RawMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.shutdownIDs) == 0 {
		return nil
	}
	id := r.shutdownIDs[0]
	r.shutdownIDs = r.shutdownIDs[1:]
	return id
}
