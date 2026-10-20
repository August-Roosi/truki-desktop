// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !windows

package main

import (
	"os"
	"syscall"
)

// dupStdout duplicates the real stdout so RPC can keep using it after
// os.Stdout is redirected to stderr.
func dupStdout() (*os.File, error) {
	fd, err := syscall.Dup(int(os.Stdout.Fd()))
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), "stdout"), nil
}

// redirectStdoutToStderr points fd 1 at stderr so stray writes from
// libraries land in the log stream instead of the RPC stream.
func redirectStdoutToStderr() error {
	return syscall.Dup2(int(os.Stderr.Fd()), int(os.Stdout.Fd()))
}
