// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func key(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

func newDBPath(t *testing.T) string { return filepath.Join(t.TempDir(), "bridge.db") }

func TestOpenCreatesEncryptedFile(t *testing.T) {
	p := newDBPath(t)
	db, err := Open(p, key(1))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err = db.Exec(ctx, "CREATE TABLE t (x TEXT)"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "INSERT INTO t VALUES ('hello')"); err != nil {
		t.Fatal(err)
	}
	if err = db.RawDB.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 16 || bytes.HasPrefix(raw, []byte("SQLite format 3\x00")) {
		t.Fatalf("file is not encrypted: %q", raw[:min(16, len(raw))])
	}
}

func TestOpenWrongKey(t *testing.T) {
	p := newDBPath(t)
	db, err := Open(p, key(1))
	if err != nil {
		t.Fatal(err)
	}
	db.Exec(context.Background(), "CREATE TABLE t (x TEXT)")
	db.RawDB.Close()
	if _, err = Open(p, key(2)); !errors.Is(err, ErrBadKey) {
		t.Fatalf("want ErrBadKey, got %v", err)
	}
}

func TestOpenRightKey(t *testing.T) {
	p := newDBPath(t)
	db, err := Open(p, key(1))
	if err != nil {
		t.Fatal(err)
	}
	db.Exec(context.Background(), "CREATE TABLE t (x TEXT)")
	db.Exec(context.Background(), "INSERT INTO t VALUES ('hello')")
	db.RawDB.Close()
	db, err = Open(p, key(1))
	if err != nil {
		t.Fatal(err)
	}
	defer db.RawDB.Close()
	var got string
	if err = db.QueryRow(context.Background(), "SELECT x FROM t").Scan(&got); err != nil || got != "hello" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestCipherVersion(t *testing.T) {
	db, err := Open(newDBPath(t), key(1))
	if err != nil {
		t.Fatal(err)
	}
	defer db.RawDB.Close()
	var v string
	if err = db.QueryRow(context.Background(), "PRAGMA cipher_version").Scan(&v); err != nil || v == "" {
		t.Fatalf("cipher_version = %q, %v", v, err)
	}
}

func TestFTS5Available(t *testing.T) {
	db, err := Open(newDBPath(t), key(1))
	if err != nil {
		t.Fatal(err)
	}
	defer db.RawDB.Close()
	if _, err = db.Exec(context.Background(), "CREATE VIRTUAL TABLE t USING fts5(x)"); err != nil {
		t.Fatal(err)
	}
}

func TestCheckCipherVersion(t *testing.T) {
	if err := checkCipherVersion(sql.NullString{}, sql.ErrNoRows); !errors.Is(err, ErrNoSQLCipher) {
		t.Fatalf("no row: %v", err)
	}
	if err := checkCipherVersion(sql.NullString{Valid: true}, nil); !errors.Is(err, ErrNoSQLCipher) {
		t.Fatalf("empty: %v", err)
	}
	if err := checkCipherVersion(sql.NullString{String: "4.19.0", Valid: true}, nil); err != nil {
		t.Fatal(err)
	}
}
