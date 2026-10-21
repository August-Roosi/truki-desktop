// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// buildFaketest builds the bridge with the fake network compiled in
// (-tags faketest, plus the SQLCipher tags scripts/test.sh builds with).
func buildFaketest(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "truki-bridge-faketest")
	build := exec.Command("go", "build", "-tags", "faketest,libsqlite3,sqlite_fts5", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

func randomHexKey() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func initLine(id int, dataDir, key string) string {
	params := map[string]any{"protocolVersion": 1, "dataDir": dataDir, "dbKey": key}
	line, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "init", "params": params})
	if err != nil {
		panic(err)
	}
	return string(line)
}

// child is one running bridge process with line helpers for the RPC pipe.
type child struct {
	t        *testing.T
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	stdout   *bufio.Scanner
	stderr   bytes.Buffer
	watchdog *time.Timer
}

func startChild(t *testing.T, bin string) *child {
	t.Helper()
	c := &child{t: t}
	c.cmd = exec.Command(bin)
	stdin, err := c.cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	c.stdin = stdin
	out, err := c.cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	c.stdout = bufio.NewScanner(out)
	c.cmd.Stderr = &c.stderr
	if err := c.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	// Mirror the supervisor's 5s kill so a hung child fails the test
	// instead of hanging it.
	c.watchdog = time.AfterFunc(5*time.Second, func() { _ = c.cmd.Process.Kill() })
	return c
}

type rpcLine struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Code string `json:"code"`
		} `json:"data"`
	} `json:"error"`
}

func (c *child) send(line string) {
	c.t.Helper()
	if _, err := io.WriteString(c.stdin, line+"\n"); err != nil {
		c.t.Fatalf("write request: %v", err)
	}
}

// line reads one JSON-RPC line from the child's stdout.
func (c *child) line() rpcLine {
	c.t.Helper()
	if !c.stdout.Scan() {
		c.t.Fatalf("no more output on stdout (stderr: %q)", c.stderr.String())
	}
	var l rpcLine
	if err := json.Unmarshal([]byte(c.stdout.Text()), &l); err != nil {
		c.t.Fatalf("bad JSON-RPC line %q: %v", c.stdout.Text(), err)
	}
	return l
}

// wait waits for the child to exit and returns the Wait error (nil for
// status 0).
func (c *child) wait() error {
	c.watchdog.Stop()
	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		_ = c.cmd.Process.Kill()
		return <-done
	}
}

// TestShutdown runs the binary with the fake network, inits, shuts down and
// expects the process to answer {} and exit 0 within 5 seconds.
func TestShutdown(t *testing.T) {
	bin := buildFaketest(t)
	dataDir := t.TempDir()

	c := startChild(t, bin)
	c.send(initLine(1, dataDir, randomHexKey()))
	init := c.line()
	if init.Error != nil {
		t.Fatalf("init failed: %+v (stderr %q)", init.Error, c.stderr.String())
	}
	var res struct {
		Networks []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"networks"`
	}
	if err := json.Unmarshal(init.Result, &res); err != nil {
		t.Fatalf("init result %s: %v", init.Result, err)
	}
	if len(res.Networks) != 1 || res.Networks[0].ID != "fake" {
		t.Fatalf("init networks = %+v; want the fake network (build with -tags faketest)", res.Networks)
	}

	c.send(`{"jsonrpc":"2.0","id":2,"method":"shutdown"}`)
	down := c.line()
	if down.Error != nil {
		t.Fatalf("shutdown failed: %+v", down.Error)
	}
	var result map[string]any
	if err := json.Unmarshal(down.Result, &result); err != nil || len(result) != 0 {
		t.Fatalf("shutdown result = %s / %v; want {}", down.Result, err)
	}
	if err := c.wait(); err != nil {
		t.Fatalf("the bridge did not exit 0 after shutdown: %v (stderr %q)", err, c.stderr.String())
	}
}

// TestInitWrongKeyFails runs the binary twice on the same dataDir with two
// different keys: the second init must answer INTERNAL, mention the bad
// key, never leak either key, and exit 1 so the supervisor treats it as a
// crash.
func TestInitWrongKeyFails(t *testing.T) {
	bin := buildFaketest(t)
	dataDir := t.TempDir()
	keyA, keyB := randomHexKey(), randomHexKey()

	// First run: a good init creates the database; EOF ends the process.
	c := startChild(t, bin)
	c.send(initLine(1, dataDir, keyA))
	if l := c.line(); l.Error != nil {
		t.Fatalf("first init failed: %+v (stderr %q)", l.Error, c.stderr.String())
	}
	if err := c.stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := c.wait(); err != nil {
		t.Fatalf("first run exited with %v (stderr %q)", err, c.stderr.String())
	}

	// Second run, same dataDir, a different key.
	c2 := startChild(t, bin)
	c2.send(initLine(1, dataDir, keyB))
	l := c2.line()
	if l.Error == nil {
		t.Fatal("init with the wrong key succeeded; want an INTERNAL error")
	}
	if l.Error.Data.Code != "INTERNAL" || !strings.Contains(l.Error.Message, "bad key") {
		t.Fatalf("init error = %+v; want INTERNAL mentioning a bad key", l.Error)
	}
	if strings.Contains(l.Error.Message, keyB) {
		t.Error("the init error leaks the database key")
	}
	if err := c2.wait(); err == nil {
		t.Fatal("the process exited 0 after a bad key; want status 1")
	} else if code := c2.cmd.ProcessState.ExitCode(); code != 1 {
		t.Fatalf("exit status = %d; want 1", code)
	}
	for _, out := range []string{c2.stderr.String(), string(l.Error.Message)} {
		if strings.Contains(out, keyA) || strings.Contains(out, keyB) {
			t.Error("a database key appeared in the child's output")
		}
	}
}
