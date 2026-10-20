#!/usr/bin/env bash
# Copyright 2026 Truki
# SPDX-License-Identifier: AGPL-3.0-only
# Usage: build.sh <linux-amd64|windows-amd64>  ->  dist/<target>/truki-bridge[.exe]
set -euo pipefail
TARGET="${1:?usage: $0 <linux-amd64|windows-amd64>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build-sqlcipher.sh" "$TARGET"
B="$ROOT/third_party/build/$TARGET"
cd "$ROOT"
LDX="-L$B/lib -lsqlcipher -ltomcrypt"
OUT="dist/$TARGET/truki-bridge"
case "$TARGET" in
  linux-amd64) export GOOS=linux GOARCH=amd64 ;;
  windows-amd64) export GOOS=windows GOARCH=amd64 CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++
    LDX="$LDX -static"; OUT="$OUT.exe" ;;
  *) echo "unknown target $TARGET" >&2; exit 2 ;;
esac
VERSION="$(git describe --always 2>/dev/null || echo dev)"
CGO_ENABLED=1 CGO_CFLAGS="-I$B/include/sqlcipher" CGO_LDFLAGS="$LDX" \
  go build -tags libsqlite3,sqlite_fts5 -ldflags "-X main.Version=$VERSION" -o "$OUT" ./cmd/truki-bridge
echo "built $OUT"
