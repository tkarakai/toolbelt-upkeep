# Toolbelt Upkeep

Upkeep keeps the apps, runtimes, packages and git clones you choose up to date. It is an
independently packaged macOS plugin for [Toolbelt](https://github.com/tkarakai/toolbelt).

## Use

In Toolbelt's plugin manager, enter `tkarakai/toolbelt-upkeep`, review the release and publisher,
and approve execution. Select a release tag or enable prereleases when installing a prerelease.
Toolbelt downloads the ready-to-run archive and manages installation, updates and removal.
Plugin code runs with your user privileges; process isolation is not a security sandbox.

- **Updates** groups what you watch by what needs doing (needs you, ready, review first, up to
  date, held back). **Update** is one click; **Review & update…** beside it shows commands and
  release notes first. Progress shows on the row, in a card at the top and in the review dialog,
  and every run ends with one summary of what changed.
- **Discover** scans only when asked and shows what's new, gone or changed since the last scan,
  including watched items it no longer finds. Stop watching never uninstalls software.
- **Activity** shows what's running now (live logs, cancellation) above the audit history, one
  entry per run with its items inside.
- **Settings** controls checking, automatic-update policy, discovery folders and custom recipes.
  The menu-bar quick view summarizes updates and items needing attention.

A fresh installation watches nothing. Items default to notify-only and automatic updates are
off globally. Passwords, app quitting and custom commands require attention. Custom commands
must be reviewed and never run automatically. Bulk updates exclude items requiring individual
review, including apps, major upgrades, blocked/auth-required items, pins and skipped versions.

Update the plugin through Toolbelt's plugin manager. Upkeep defers unloading or upgrading while
work is queued or running; let it finish (Activity › Now) or explicitly cancel it before retrying. Disabling
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
- `dist/toolbelt-upkeep-<version>-darwin-arm64.tar.gz`: the ready-to-run package for Apple silicon.
- `dist/toolbelt-release.json`: plugin/repository identity, source commit, target assets,
  byte sizes and SHA-256 hashes.
- `dist/*.sha256`: checksum sidecars.

Local builds create files only. Use the [release commands](docs/releases.md) to prepare a version PR. Merging the validated release PR authorizes CI publication after archive/native checks.

Writable state belongs in the host-provided data directory. Schema 1 initialization and
unchanged-schema migration are explicit no-ops; unknown schemas reject. When changing data
formats, implement retry-safe migration, declare supported schemas and test failure/recovery.
