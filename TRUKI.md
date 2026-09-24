# Truki

Truki is a fork of [Signal Desktop](https://github.com/signalapp/Signal-Desktop),
based on upstream tag `v8.27.0`. It is not affiliated with or endorsed by Signal
Messenger, LLC.

Like upstream, Truki is licensed under the
[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html). The changes below were
made on top of upstream in September 2026.

## Changes from upstream

- **Name and identity.** `productName` is `Truki` and the application id is
  `org.truki.desktop`, so Truki keeps its own data directory
  (`%AppData%\Truki`) and can run alongside an ordinary Signal Desktop install.

  The app name must stay ASCII. With a non-ASCII name (`Trüki`), Electron's
  privileged custom protocols (`attachment:` and `asset:`) fail with
  `net::ERR_UNEXPECTED` before reaching the handler, and photos, avatars,
  stickers and some icons silently fall back to placeholders.

- **Updates come from this repository.** `config/production.json` points
  `updatesUrl` at this repo's latest GitHub release and carries Truki's own
  `updatesPublicKey`, replacing Signal's update servers and key.

- **Code signing.** `scripts/truki-sign-windows.mjs` signs the Windows binaries
  during packaging with Truki's certificate. It is currently a self-signed
  certificate, so Windows SmartScreen warns on install unless the certificate is
  trusted on the machine.

- **Green message bubbles**, as a first visible change.

## Building a release

Requires Node matching `.nvmrc`, pnpm, Python and the Visual Studio 2022 C++
build tools.

```sh
pnpm install          # re-run after switching branches: Electron version matters
pnpm run build        # generates, bundles, packages and signs into release/
node scripts/truki-sign-update.mjs release/truki-desktop-win-x64-<version>.exe
gh release create v<version> \
  release/truki-desktop-win-x64-<version>.exe \
  release/truki-desktop-win-x64-<version>.exe.sig \
  release/truki-desktop-win-x64-<version>.exe.blockmap \
  release/latest.yml
```

Sign the installer *during* packaging, never afterwards: `latest.yml` records
the installer's hash, and signing it later makes the updater reject the build.

The signing keys are deliberately not in this repository. The updater verifies
`<installer>.sig` against `updatesPublicKey` before installing anything, so
whoever holds `update-private-key.hex` controls what Truki installs.

Builds expire roughly 90 days after they are made; after that the app refuses to
start until a newer release is installed.
