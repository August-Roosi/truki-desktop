// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// dupStdout duplicates the real stdout so RPC can keep using it after
// os.Stdout is redirected to stderr.
func dupStdout() (*os.File, error) {
	cur, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	if err != nil {
		return nil, err
	}
	var dup windows.Handle
	err = windows.DuplicateHandle(
		windows.CurrentProcess(), cur,
		windows.CurrentProcess(), &dup,
		0, true, windows.DUPLICATE_SAME_ACCESS)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(dup), "stdout"), nil
}

// redirectStdoutToStderr repoints the process stdout handle at stderr so
// stray writes from libraries land in the log stream instead of the RPC
// stream.
func redirectStdoutToStderr() error {
	stderr, err := windows.GetStdHandle(windows.STD_ERROR_HANDLE)
	if err != nil {
		return err
	}
	return windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, stderr)
}

// writeFD1 has no fd-1 equivalent on Windows: the C runtime's fd 1 is not
// addressable the way a unix fd is, and the guard's SetStdHandle path is
// exercised through the os.Stdout redirect instead.
func writeFD1(string) error { return nil }
