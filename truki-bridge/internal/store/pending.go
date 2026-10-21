// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package store

import "context"

// FailPendingEvents marks every still-pending event as failed with error
// code INTERNAL. A pending send cannot survive a bridge restart: nothing
// will ever report its final status. It returns how many events were
// failed, and is a no-op (0, nil) when nothing is pending.
func (s *Store) FailPendingEvents(ctx context.Context) (int, error) {
	res, err := s.DB.Exec(ctx, `
		UPDATE event SET status = 'failed', error_code = 'INTERNAL'
		WHERE status = 'pending'
	`)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}
