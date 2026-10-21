#!/usr/bin/env bash
# Copyright 2026 Truki
# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds static SQLCipher + libtomcrypt for a target.
# Usage: build-sqlcipher.sh <linux-amd64|windows-amd64>
# Output: third_party/build/<target>/{include,lib}
set -euo pipefail

SQLCIPHER_VERSION=4.19.0
SQLCIPHER_SHA256=7075f96cbabe45b4ecfc2e6b1745a625f856f695b0827a5506ce9ed85b906aa0
SQLCIPHER_URL="https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v${SQLCIPHER_VERSION}.tar.gz"
LTC_VERSION=1.18.2
LTC_SHA256=96ad4c3b8336050993c5bc2cf6c057484f2b0f9f763448151567fbab5e767b84
LTC_URL="https://github.com/libtom/libtomcrypt/releases/download/v${LTC_VERSION}/crypt-${LTC_VERSION}.tar.xz"

TARGET="${1:?usage: $0 <linux-amd64|windows-amd64>}"
case "$TARGET" in
  linux-amd64) CC=${CC:-gcc}; AR=ar ;;
  windows-amd64) CC=x86_64-w64-mingw32-gcc; AR=x86_64-w64-mingw32-ar ;;
  *) echo "unknown target $TARGET" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DL="$ROOT/third_party/dl"
SRC="$ROOT/third_party/src/$TARGET"
OUT="$ROOT/third_party/build/$TARGET"
AMALG="$ROOT/third_party/src/amalgamation"

if [[ -f "$OUT/lib/libsqlcipher.a" && -f "$OUT/lib/libsqlite3.a" && -f "$OUT/lib/libtomcrypt.a" && -f "$OUT/include/sqlcipher/sqlite3.h" ]]; then
  echo "build-sqlcipher: $TARGET already built"
  exit 0
fi

mkdir -p "$DL" "$SRC" "$OUT/include/sqlcipher" "$OUT/lib"

fetch() { # url file sha
  if [[ ! -f "$DL/$2" ]]; then curl -fsSL -o "$DL/$2" "$1"; fi
  (cd "$DL" && echo "$3  $2" | sha256sum -c -)
}
fetch "$SQLCIPHER_URL" "sqlcipher-${SQLCIPHER_VERSION}.tar.gz" "$SQLCIPHER_SHA256"
fetch "$LTC_URL" "libtomcrypt-${LTC_VERSION}.tar.xz" "$LTC_SHA256"

# libtomcrypt (no math provider: SQLCipher only needs symmetric ciphers, hashes, HMAC, PBKDF2)
rm -rf "$SRC/ltc"; mkdir -p "$SRC/ltc"
tar xf "$DL/libtomcrypt-${LTC_VERSION}.tar.xz" -C "$SRC/ltc" --strip-components=1
make -C "$SRC/ltc" -j"$(nproc)" CC="$CC" AR="$AR" RANLIB="${AR%ar}ranlib" \
  CFLAGS="-O2" EXTRALIBS= libtomcrypt.a
cp "$SRC/ltc/libtomcrypt.a" "$OUT/lib/"
mkdir -p "$OUT/include/tomcrypt"
cp "$SRC/ltc"/src/headers/*.h "$OUT/include/tomcrypt/"

# SQLCipher amalgamation is generated natively (needs tcl), once, and shared by targets.
if [[ ! -f "$AMALG/sqlite3.c" ]]; then
  rm -rf "$AMALG"; mkdir -p "$AMALG/s"
  tar xzf "$DL/sqlcipher-${SQLCIPHER_VERSION}.tar.gz" -C "$AMALG/s" --strip-components=1
  (cd "$AMALG/s" && ./configure --disable-tcl >/dev/null && make -j"$(nproc)" sqlite3.c >/dev/null)
  cp "$AMALG/s/sqlite3.c" "$AMALG/s/sqlite3.h" "$AMALG/s/sqlite3ext.h" "$AMALG/"
fi

DEFS="-DSQLITE_EXTRA_INIT=sqlcipher_extra_init -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown -DSQLITE_HAS_CODEC -DSQLCIPHER_CRYPTO_LIBTOMCRYPT -DSQLITE_ENABLE_FTS5 -DSQLITE_TEMP_STORE=2 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_THREADSAFE=1"
$CC -O2 $DEFS -I"$SRC/ltc/src/headers" -c "$AMALG/sqlite3.c" -o "$SRC/sqlite3.o"
rm -f "$OUT/lib/libsqlcipher.a"
$AR rcs "$OUT/lib/libsqlcipher.a" "$SRC/sqlite3.o"
# go-sqlite3 (libsqlite3 tag) hardcodes -lsqlite3; provide the same archive under that name.
cp "$OUT/lib/libsqlcipher.a" "$OUT/lib/libsqlite3.a"
cp "$AMALG/sqlite3.h" "$AMALG/sqlite3ext.h" "$OUT/include/sqlcipher/"
echo "build-sqlcipher: built $TARGET"
