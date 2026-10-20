// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestStdoutGuard runs the binary with --test-print-stdout: it prints a
// stray garbage line to stdout, then serves RPC over the guarded stdout
// handle. A client doing init must still get a valid response.
func TestStdoutGuard(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "truki-bridge-stdout-guard")
	build := exec.Command("go", "build", "-tags", "libsqlite3,sqlite_fts5", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	dataDir := t.TempDir()
	cmd := exec.Command(bin, "--test-print-stdout")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()

	lines := make(chan string)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()

	go func() {
		io.WriteString(stdin, `{"jsonrpc":"2.0","id":1,"method":"init","params":{"protocolVersion":1,"dataDir":`+
			`"`+dataDir+`","dbKey":"`+strings.Repeat("ab", 32)+`"}}`+"\n")
	}()

	garbage := 0
	var result map[string]any
	deadline := time.After(30 * time.Second)
	for result == nil {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatal("stdout closed before an init response arrived")
			}
			if !json.Valid([]byte(line)) {
				garbage++
				continue
			}
			var resp struct {
				Result map[string]any `json:"result"`
				Error  *struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal([]byte(line), &resp); err != nil {
				t.Fatalf("bad response line %q: %v", line, err)
			}
			if resp.Error != nil {
				t.Fatalf("init error: %d %s", resp.Error.Code, resp.Error.Message)
			}
			result = resp.Result
		case <-deadline:
			t.Fatal("timed out waiting for the init response")
		}
	}

	if garbage == 0 {
		t.Error("expected the garbage line on stdout before the response")
	}
	if result["protocolVersion"] != float64(1) {
		t.Errorf("protocolVersion = %v, want 1", result["protocolVersion"])
	}
	if v, _ := result["bridgeVersion"].(string); v == "" {
		t.Error("bridgeVersion is empty")
	}

	// Closing stdin ends the serve loop and the process exits cleanly.
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("bridge exited with error: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Error("bridge did not exit after stdin closed")
	}
}
