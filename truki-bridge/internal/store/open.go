// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Package store opens the bridge's SQLCipher-encrypted database.
package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/url"
	"path/filepath"
	"sync"

	"github.com/mattn/go-sqlite3"
	"go.mau.fi/util/dbutil"
)

// ErrBadKey is returned when the database exists but the key does not decrypt it.
var ErrBadKey = errors.New("wrong database key or not a SQLCipher database")

const driverName = "truki-sqlcipher"

var registerOnce sync.Once

func registerDriver() {
	registerOnce.Do(func() {
		sql.Register(driverName, &sqlite3.SQLiteDriver{
			ConnectHook: func(conn *sqlite3.SQLiteConn) error {
				for _, q := range []string{
					"PRAGMA foreign_keys = ON",
					"PRAGMA journal_mode = WAL",
					"PRAGMA synchronous = NORMAL",
					"PRAGMA busy_timeout = 5000",
				} {
					if _, err := conn.Exec(q, nil); err != nil {
						return err
					}
				}
				return nil
			},
		})
	})
}

func isNotADB(err error) bool {
	var se sqlite3.Error
	return errors.As(err, &se) && se.Code == sqlite3.ErrNotADB
}

// Open opens (creating if needed) the encrypted database at path using a raw
// key (hex-encoded into SQLCipher's raw-key form, so it must be 32 bytes of
// real key material, not a passphrase).
//
// The key is passed as SQLCipher's "hexkey" URI parameter instead of
// "PRAGMA key" in a connect hook: go-sqlite3 runs PRAGMA synchronous (which
// reads the schema) before any ConnectHook, which would fail on an existing
// encrypted file.
func Open(path string, key []byte) (*dbutil.Database, error) {
	if len(key) != 32 {
		return nil, errors.New("database key must be 32 bytes")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	registerDriver()
	u := url.URL{Scheme: "file", Path: abs}
	if filepath.VolumeName(abs) != "" { // windows: file:///C:/...
		u.Path = "/" + filepath.ToSlash(abs)
	}
	u.RawQuery = "hexkey=" + hex.EncodeToString(key) + "&_txlock=immediate"

	raw, err := sql.Open(driverName, u.String())
	if err != nil {
		return nil, err
	}
	raw.SetMaxOpenConns(1)
	db, err := dbutil.NewWithDB(raw, "sqlite3")
	if err != nil {
		raw.Close()
		return nil, err
	}
	var n int
	if err = db.QueryRow(context.Background(), "SELECT count(*) FROM sqlite_master").Scan(&n); err != nil {
		raw.Close()
		if isNotADB(err) {
			return nil, ErrBadKey
		}
		return nil, err
	}
	return db, nil
}
