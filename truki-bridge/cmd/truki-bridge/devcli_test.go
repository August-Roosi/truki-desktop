// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

// execDevCLI runs `bin devcli --data dir` with input on stdin and returns
// its stdout.
func execDevCLI(t *testing.T, bin, dir, input string) string {
	t.Helper()
	cmd := exec.Command(bin, "devcli", "--data", dir)
	cmd.Stdin = strings.NewReader(input)
	var out strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &out
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("devcli: %v\n%s", err, out.String())
		}
	case <-time.After(20 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("devcli hung\n%s", out.String())
	}
	return out.String()
}

// TestDevCLI drives devcli against the fake network: a user_input login
// prompts for the username, a QR login renders every code and follows the
// pushed steps to completion, and a second run reuses the key file it
// created on the first.
func TestDevCLI(t *testing.T) {
	bin := buildFaketest(t)
	dir := t.TempDir()

	out := execDevCLI(t, bin, dir, strings.Join([]string{
		"flows fake",
		"login fake fake",
		"alice",
		"login fake fake-qr",
		"accounts",
		"quit",
	}, "\n")+"\n")
	for _, want := range []string{
		`"id":"fake-qr"`,      // flows result
		"Username",            // user_input prompt
		"logged in: alice",    // user_input login completed
		"▀",                   // a QR code was rendered
		"event.login.step",    // pushed steps are printed
		"logged in: qr-user",  // display_and_wait login completed
		`"loginId":"qr-user"`, // accounts result
		`"loginId":"alice"`,   //
	} {
		if !strings.Contains(out, want) {
			t.Errorf("first run output lacks %q:\n%s", want, out)
		}
	}

	keyPath := filepath.Join(dir, "devcli.key")
	key, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("key file: %v", err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}\n?$`).Match(key) {
		t.Errorf("key file content %q; want 64 hex chars", key)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(keyPath)
		if err != nil {
			t.Fatal(err)
		}
		if mode := st.Mode().Perm(); mode != 0o600 {
			t.Errorf("key file mode %o; want 600", mode)
		}
	}

	// The second run opens the same database, so it must reuse the key; it
	// also ends on stdin EOF without an explicit quit.
	out = execDevCLI(t, bin, dir, "accounts\n")
	if !strings.Contains(out, `"loginId":"alice"`) {
		t.Errorf("second run does not see the first run's login:\n%s", out)
	}
	if after, _ := os.ReadFile(keyPath); string(after) != string(key) {
		t.Error("key file changed on the second run")
	}
}
