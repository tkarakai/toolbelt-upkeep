# Toolbelt Upkeep

Upkeep keeps the apps, runtimes, packages and git clones you choose up to date. It is an
independently packaged macOS plugin for [Toolbelt](https://github.com/tkarakai/toolbelt).

## Use

In Toolbelt's plugin manager, enter `tkarakai/toolbelt-upkeep`, review the release and publisher,
and approve execution. Select a release tag or enable prereleases when installing a prerelease.
Toolbelt downloads the ready-to-run archive and manages installation, updates and removal.
Plugin code runs with your user privileges; process isolation is not a security sandbox.

- **Discover** scans only when asked. Watch the items you want; Stop watching removes monitoring
  without uninstalling software.
- **Watching** shows installed/newest versions, scheduled checks, channels, end-of-life warnings,
  pins, skipped versions and available rollback actions.
- **Review & update** shows commands and release notes before an update.
- **Queue** shows running work, logs and cancellation. **Activity** preserves the audit trail.
- **Settings** controls checking, automatic-update policy, discovery folders and custom recipes.
  The menu-bar quick view summarizes updates and items needing attention.

A fresh installation watches nothing. Items default to notify-only and automatic updates are
off globally. Passwords, app quitting and custom commands require attention. Custom commands
must be reviewed and never run automatically. Bulk updates exclude items requiring individual
review, including apps, major upgrades, blocked/auth-required items, pins and skipped versions.

Update the plugin through Toolbelt's plugin manager. Upkeep defers unloading or upgrading while
work is queued or running; let Queue finish or explicitly cancel work before retrying. Disabling
retains the package and data. Removal retains data unless you separately choose to delete it.
Plugin data recovery does not undo software updates performed by its providers.

## Develop and maintain

Read [the architecture](docs/architecture.md) and [agent instructions](AGENTS.md).

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

The public `@toolbelt/sdk` dependency is pinned in `package.json` and `bun.lock`. No Toolbelt
source checkout is required. The host provides the Bun runtime; the build bundles JavaScript
dependencies. Toolbelt does not build this source or install dependencies at runtime.

Open a built archive in **Toolbelt Plugin Tester**, enter its publisher repository and approve
execution. Use an isolated tester profile and temporary HOME/data, with fake feeds, scratch
recipes and throwaway repositories. Check every screen and quick view, dialogs, keyboard
shortcuts, themes, narrow layouts, zoom and lifecycle diagnostics. Never exercise updates
against installed software or the person's working repositories.

The test suite covers provider/version policy, engine safety and persistence, migration,
and execution of actual archives outside this checkout without ambient `node_modules`.
For changes, add coverage where behavior is owned: providers in `providers/`, orchestration
in `lib/engine.ts`, UI definitions in `ui.ts`, events in `index.ts`, and packaging in `scripts/`.

To update the SDK dependency, choose a public compatible SDK release asset, change the pinned
dependency with Bun and commit the regenerated lockfile. Keep required capabilities and runtime
requirements in `toolbelt.json` consistent with actual usage. Run the checks above and test the
resulting archive with a compatible released tester. Do not copy SDK source into this repo.

## Package and release

`bun run build` produces:

- `dist/upkeep/`: bundled `index.js`, `migrate.js`, manifest and provenance notice.
- `dist/toolbelt-upkeep-<version>-darwin-{arm64,x64}.tar.gz`: target-specific ready-to-run packages.
- `dist/toolbelt-release.json`: plugin/repository identity, source commit, target assets,
  byte sizes and SHA-256 hashes.
- `dist/*.sha256`: checksum sidecars.

Archives use ustar without macOS copyfile metadata. Keep packages immutable: never overwrite
published bytes under an existing plugin version. Use a distinct version for changed package
bytes. Version changes belong in a release PR, with `package.json`, manifest and changelog kept
consistent. Publish only when explicitly authorized.

Build from the exact clean release commit after frozen dependency installation, typecheck and
tests. Create a draft GitHub release containing the descriptor, both target archives and their
checksum sidecars. Download the draft assets and check their bytes against the descriptor;
unpack and run them with the supported host/tester before publishing. Mark prereleases
explicitly and keep them out of the stable latest feed. Toolbelt resolves the descriptor and
checks identity, target, compatibility and checksums before executing an approved package.

Writable state belongs in the host-provided data directory. Schema 1 initialization and
unchanged-schema migration are explicit no-ops; unknown schemas reject. When changing data
formats, implement retry-safe migration, declare supported schemas and test failure/recovery.
