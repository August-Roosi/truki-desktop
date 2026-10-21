// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// SelfTest runs the same checks as the unit tests in-process, inside dir, so a
// built binary can prove its SQLCipher linkage on the target platform.
func SelfTest(dir string) error {
	ctx := context.Background()
	p := filepath.Join(dir, "selftest.db")
	k1, k2 := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)

	db, err := Open(p, k1)
	if err != nil {
		return fmt.Errorf("open: %w", err)
	}
	for _, q := range []string{"CREATE TABLE t (x TEXT)", "INSERT INTO t VALUES ('hello')", "CREATE VIRTUAL TABLE f USING fts5(x)"} {
		if _, err = db.Exec(ctx, q); err != nil {
			return fmt.Errorf("%s: %w", q, err)
		}
	}
	var ver string
	if err = db.QueryRow(ctx, "PRAGMA cipher_version").Scan(&ver); err != nil || ver == "" {
		return fmt.Errorf("cipher_version %q: %v", ver, err)
	}
	db.RawDB.Close()

	raw, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	if len(raw) < 16 || bytes.HasPrefix(raw, []byte("SQLite format 3\x00")) {
		return errors.New("file is not encrypted")
	}
	if _, err = Open(p, k2); !errors.Is(err, ErrBadKey) {
		return fmt.Errorf("wrong key: want ErrBadKey, got %v", err)
	}
	db, err = Open(p, k1)
	if err != nil {
		return fmt.Errorf("reopen: %w", err)
	}
	defer db.RawDB.Close()
	var got string
	if err = db.QueryRow(ctx, "SELECT x FROM t").Scan(&got); err != nil || got != "hello" {
		return fmt.Errorf("read back %q: %v", got, err)
	}
	fmt.Println("selftest: cipher_version", ver)
	return nil
}
