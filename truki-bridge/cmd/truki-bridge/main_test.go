// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestStdoutGuard runs the binary with --test-print-stdout: the stdout
// guard is installed first, then the binary prints stray garbage through
// the os.Stdout variable and straight to file descriptor 1, then serves
// RPC on the guarded handle. Every line on the child's stdout must be
// valid JSON-RPC, the init request must be answered, and the garbage must
// land on the child's stderr.
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
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	initReq := `{"jsonrpc":"2.0","id":1,"method":"init","params":{"protocolVersion":1,"dataDir":` +
		`"` + dataDir + `","dbKey":"` + strings.Repeat("ab", 32) + `"}}`
	if _, err := io.WriteString(stdin, initReq+"\n"); err != nil {
		t.Fatal(err)
	}
	// Closing stdin ends the serve loop once the request is answered.
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}

	// Every line on stdout must be valid JSON-RPC; count anything else.
	var result map[string]any
	garbage := 0
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		line := sc.Text()
		var resp struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Result  map[string]any  `json:"result"`
			Error   *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &resp); err != nil || resp.JSONRPC != "2.0" {
			garbage++
			t.Errorf("non-JSON-RPC line on stdout: %q", line)
			continue
		}
		if resp.Error != nil {
			t.Errorf("init error: %d %s", resp.Error.Code, resp.Error.Message)
			continue
		}
		if strings.TrimSpace(string(resp.ID)) == "1" {
			result = resp.Result
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("bridge exited with error: %v", err)
	}

	if garbage != 0 {
		t.Errorf("%d non-JSON-RPC line(s) reached the child's stdout", garbage)
	}
	if result == nil {
		t.Fatal("no init response arrived on stdout")
	}
	if result["protocolVersion"] != float64(1) {
		t.Errorf("protocolVersion = %v, want 1", result["protocolVersion"])
	}
	if v, _ := result["bridgeVersion"].(string); v == "" {
		t.Error("bridgeVersion is empty")
	}

	// The stray writes made after the guard was installed must have
	// landed on stderr, never on stdout.
	if !strings.Contains(stderr.String(), stdoutGarbageVar) {
		t.Errorf("os.Stdout garbage missing from stderr: %q", stderr.String())
	}
	if runtime.GOOS != "windows" && !strings.Contains(stderr.String(), stdoutGarbageFD1) {
		t.Errorf("fd 1 garbage missing from stderr: %q", stderr.String())
	}
}
