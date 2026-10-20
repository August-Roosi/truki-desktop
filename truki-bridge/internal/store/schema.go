// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"embed"

	"go.mau.fi/util/dbutil"
)

//go:embed upgrades/*.sql
var upgradesFS embed.FS

var upgradeTable = dbutil.BuildUpgradeTable().
	WithFSPath(upgradesFS, "upgrades").
	Finish()

// Store is the Truki bridge database store.
type Store struct {
	DB *dbutil.Database

	chats  *dbutil.QueryHelper[*Chat]
	events *dbutil.QueryHelper[*Event]
}

// New creates a new Store from a dbutil.Database.
// The database should be opened with store.Open.
func New(db *dbutil.Database) *Store {
	child := db.Child("truki_version", upgradeTable, nil)
	return &Store{
		DB:     child,
		chats:  dbutil.MakeQueryHelper[*Chat](child, nil),
		events: dbutil.MakeQueryHelper[*Event](child, nil),
	}
}

// Upgrade runs the Truki schema upgrades on the database.
// It uses its own version table "truki_version" to avoid conflicts with bridgev2.
func (s *Store) Upgrade(ctx context.Context) error {
	return s.DB.Upgrade(ctx)
}
