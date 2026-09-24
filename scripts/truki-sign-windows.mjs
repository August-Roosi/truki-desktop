// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';

/** @import { CustomWindowsSignTaskConfiguration } from 'electron-builder' */

// Authenticode-signs each packaged binary with Truki's certificate, during
// packaging — so latest.yml and the blockmap are computed from the signed
// files. Signing afterwards would leave those hashes pointing at the unsigned
// build and the updater would reject it.
//
// Set TRUKI_PFX / TRUKI_PFX_PASSWORD to override the defaults below. If the
// certificate is missing, packaging continues unsigned rather than failing.

const PFX_PATH =
  process.env.TRUKI_PFX ??
  'C:/Users/roosi/Documents/signal-cli-projekt/truki-codesign/truki-codesign.pfx';
const PFX_PASSWORD = process.env.TRUKI_PFX_PASSWORD ?? 'truki-dev';
const TIMESTAMP_SERVER = 'http://timestamp.digicert.com';

/**
 * @param {CustomWindowsSignTaskConfiguration} configuration
 * @returns {Promise<void>}
 */
export async function sign(configuration) {
  if (!existsSync(PFX_PATH)) {
    console.log(`truki-sign-windows: no certificate at ${PFX_PATH}, skipping`);
    return;
  }

  const target = await realpath(configuration.path);

  // Windows PowerShell 5.1 has no `Get-PfxCertificate -Password`, so load the
  // PFX through .NET instead. PersistKeySet keeps the private key usable for
  // the signing call that follows.
  const psCommand = [
    '$ErrorActionPreference = "Stop";',
    '$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet;',
    '$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(' +
      `${JSON.stringify(PFX_PATH)}, ${JSON.stringify(PFX_PASSWORD)}, $flags);`,
    `$result = Set-AuthenticodeSignature -FilePath ${JSON.stringify(target)} -Certificate $cert`,
    `  -HashAlgorithm SHA256 -TimestampServer ${JSON.stringify(TIMESTAMP_SERVER)};`,
    // A self-signed certificate reports UnknownError until it is trusted on the
    // machine; the file is still signed, so only a real failure should throw.
    'if ($result.SignerCertificate -eq $null) { throw "signing produced no signature" }',
  ].join(' ');

  execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    { stdio: [null, process.stdout, process.stderr] }
  );
}
