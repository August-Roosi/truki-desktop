#!/usr/bin/env bash
# Copyright 2026 Truki
# SPDX-License-Identifier: AGPL-3.0-only
# Runs go test against the linux-amd64 SQLCipher build. Usage: test.sh [go test args]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build-sqlcipher.sh" linux-amd64
B="$ROOT/third_party/build/linux-amd64"
cd "$ROOT"
CGO_ENABLED=1 CGO_CFLAGS="-I$B/include/sqlcipher" CGO_LDFLAGS="-L$B/lib -lsqlcipher -ltomcrypt" \
  go test -tags libsqlite3,sqlite_fts5 "$@"
