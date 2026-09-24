# Truki

Truki is a fork of [Signal Desktop](https://github.com/signalapp/Signal-Desktop),
based on upstream tag `v8.27.0`. It is not affiliated with or endorsed by Signal
Messenger, LLC.

Like upstream, Truki is licensed under the
[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html). The changes below were
made on top of upstream in September 2026.

## Branching

Two kinds of branch, and nothing else:

- **`main`** — what Truki ships. Every release is built from here.
- **`feature/<name>`** — one branch per change, branched from `main` and merged
  back when it works.

```sh
git switch main
git pull
git switch -c feature/vacation-status
# ...work, commit...
git switch main
git merge feature/vacation-status
git push
git branch -d feature/vacation-status
```

Remotes are `origin` (this repo) and `upstream` (signalapp/Signal-Desktop).

## Taking a new Signal release

Signal ships roughly weekly, and builds expire after about 90 days, so this
needs doing every few months whether or not you want the new features.

```sh
git fetch upstream --tags
git switch main
git switch -c update/v8.31.0          # whatever the new stable tag is
git merge v8.31.0                     # merge the tag, not a branch
```

Merge conflicts will land in the handful of files Truki changes —
`package.json`, `config/production.json`, and any feature code. Keep Truki's
side for the identity and update settings; take upstream's side everywhere
else. Then:

```sh
pnpm install                          # Electron version changes between releases
pnpm run build
# launch release/win-unpacked/Truki.exe and check it works
git switch main
git merge update/v8.31.0
git push
```

Then cut the release as described below, using the new version number.

Merging (rather than rebasing onto each new tag) keeps history intact and
avoids force-pushes, so nobody's clone ever breaks. The cost is a messier
graph, which does not matter here.

Useful checks:

```sh
git log --oneline v8.27.0..main -- . ':!node_modules'   # what Truki changed
git tag --list 'v*' --sort=-v:refname | grep -v -E 'alpha|beta' | head   # newest stable
```

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

Truki currently makes no visible changes to the interface; the green message
bubbles were a test and have been reverted.

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
