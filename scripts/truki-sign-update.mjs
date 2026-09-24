// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Signs a built installer so Truki's auto-updater will accept it.
//
// Usage:
//   node scripts/truki-sign-update.mjs <path-to-installer.exe> [private-key-hex-file]
//
// Writes "<installer>.sig" next to the installer. The updater checks this
// signature against "updatesPublicKey" in config/production.json before
// installing anything, so the private key must stay off this repo.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { PrivateKey } from '@signalapp/libsignal-client';

import packageJson from '../package.json' with { type: 'json' };

const [installerPath, keyPathArg] = process.argv.slice(2);

if (!installerPath) {
  console.error(
    'usage: node scripts/truki-sign-update.mjs <installer.exe> [private-key.hex]'
  );
  process.exit(1);
}

const keyPath =
  keyPathArg ?? '../truki-codesign/update-private-key.hex';

const privateKeyHex = (await readFile(keyPath, 'utf8')).trim();
const privateKey = PrivateKey.deserialize(Buffer.from(privateKeyHex, 'hex'));

// Signal signs "<sha256-of-file-in-hex>-<version>"; see ts/updater/signature.node.ts
const hash = createHash('sha256');
await pipeline(createReadStream(installerPath), hash);
const message = Buffer.from(`${hash.digest('hex')}-${packageJson.version}`);

const signature = privateKey.sign(message);
const signaturePath = `${installerPath}.sig`;
await writeFile(signaturePath, Buffer.from(signature).toString('hex'), 'utf8');

console.log(`signed ${installerPath}`);
console.log(`  version: ${packageJson.version}`);
console.log(`  wrote:   ${signaturePath}`);
