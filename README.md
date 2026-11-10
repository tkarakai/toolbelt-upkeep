# Toolbelt Upkeep

Keeps the apps, runtimes, packages and git clones you choose up to date. An independently
packaged plugin for [Toolbelt](https://github.com/tkarakai/toolbelt).

- **Discover** reads this Mac only when asked: Homebrew, Sparkle apps, runtimes, global
  packages and git clones. Choose what to watch; Watch/Stop watching is reversible.
- **Watching** checks opted-in items on a schedule, with countdowns, channels, end-of-life
  warnings, pins, skipped versions and rollback.
- **Review & update** shows commands and release notes before a queued update.
- **Queue**, **Activity**, **Settings** and menu-bar quick view retain the shipped behavior.

Nothing is checked or changed until you choose. Updates default to notify-only. Passwords,
app quitting and custom commands never start unattended. See [docs/design.md](docs/design.md).

## Architecture v2 evaluation

The `feat/architecture2` branch targets Toolbelt architecture v2, not the official v1 app.
Install a release by entering `tkarakai/toolbelt-upkeep` in v2's plugin manager, or open the
built archive in the isolated **Toolbelt Plugin Tester**. Never copy this checkout into the
installed official app's plugin folder. Runtime packages execute with the user's privileges;
process isolation and a scratch profile are not a security sandbox.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

The public SDK is pinned to its immutable candidate release asset in `package.json` and
`bun.lock`. No sibling checkout or SDK source copy is required. Build outputs:

- `dist/upkeep/`: bundled entry, migration entry, manifest and provenance notice.
- `dist/toolbelt-upkeep-0.0.1-darwin-{arm64,x64}.tar.gz`: independently runnable archives.
- `dist/toolbelt-release.json`: source commit, target filenames, sizes and SHA-256 hashes.
- `dist/*.sha256`: checksum sidecars.

The host provides Bun (`>=1.3.0`); the package bundles all JS dependencies. CI pins Bun in
its workflow and unpacks/executes actual archives outside this source tree without ambient
`node_modules`, with a minimal environment and temporary data/home. Tests only update
scratch files through explicit custom recipes; they never update installed software.

Schema 1 preserves the existing Upkeep files and screen IDs. Migration operates on the
host's staged data copy and accepts only initialization or unchanged schema 1. Package
upgrade/unload defers while any operation is queued/running and freezes scheduling once
ready. Managed-directory rollback cannot undo provider changes to real software.

For an explicit development import, **copy** an old profile's `data/upkeep` into an isolated
tester profile's managed `data/upkeep` while the tester is stopped. Retain the original.
There is no automatic import from the working official app.

## Candidate publication

Only local artifacts or explicit prereleases belong to architecture2 evaluation. Build
from the exact clean source commit. Create a draft prerelease containing both archives,
sidecars and `toolbelt-release.json`; download and verify the published draft bytes before
publishing it as a prerelease with `--latest=false`. Never replace an existing asset/version
or move the public stable feed. Final stable version/download naming is a later decision.

See [implementation evidence](docs/architecture2-progress.md) for extraction provenance,
parity checks and pending visual verification.
