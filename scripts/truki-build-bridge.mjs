// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Cross-builds truki-bridge.exe (Go + cgo + static SQLCipher) and stages it in
// build/truki-bridge/, where electron-builder's extraResources picks it up.
// On Windows this needs Git Bash (`bash`), Go and a mingw-w64 gcc on PATH.

const root = resolve(import.meta.dirname, '..');
const bridgeDir = join(root, 'truki-bridge');

const result = spawnSync('bash', ['scripts/build.sh', 'windows-amd64'], {
  cwd: bridgeDir,
  stdio: 'inherit',
});

if (result.error != null || result.status !== 0) {
  console.error(
    'truki-build-bridge: building truki-bridge.exe failed. It needs `bash` ' +
      '(Git Bash on Windows), Go, and x86_64-w64-mingw32-gcc (mingw-w64) on PATH.'
  );
  process.exit(result.status || 1);
}

const built = join(bridgeDir, 'dist', 'windows-amd64', 'truki-bridge.exe');
if (!existsSync(built)) {
  console.error(`truki-build-bridge: expected ${built} but it does not exist`);
  process.exit(1);
}

const outDir = join(root, 'build', 'truki-bridge');
mkdirSync(outDir, { recursive: true });
copyFileSync(built, join(outDir, 'truki-bridge.exe'));
console.log(`truki-build-bridge: staged ${join(outDir, 'truki-bridge.exe')}`);
