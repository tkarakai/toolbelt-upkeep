# Upkeep architecture

Upkeep owns its screens, providers, software-update engine, data schema, migrations, tests and
release packages. Toolbelt owns rendering, plugin package installation, runtime processes and
managed-data recovery. Upkeep's software-update queue is separate from Toolbelt's plugin-package
update manager.

## Runtime and UI

Toolbelt launches the bundled entry with its Bun runtime in an independent process. The plugin
uses the public `@toolbelt/sdk` package and bounded JSON-lines messages over stdin/stdout; stderr
is diagnostic output. UI is a declarative tree rendered by Toolbelt, without plugin browser
JavaScript. The manifest declares format/protocol versions, compatibility, capabilities and
surfaces. SDK build version is diagnostic rather than an exact host-version match.

The stable plugin id is `upkeep`. Screens are `monitored` (Watching), `discover`, `queue`,
`activity` and `settings`, with a `quick` surface for the menu bar. `index.ts` handles events and
connects the SDK to Store and Engine. `ui.ts` builds the screen trees, action keys, forms,
review/log/history dialogs and quick view. Surface queries and dialogs live in plugin memory;
Toolbelt owns renderer selection, scroll and other immediate UI state.

Required capabilities are `ui.core`, `ui.action-key` and `lifecycle`. `toolbelt.json` declares
supported host/Bun ranges, macOS targets and data schema support. The package bundles its
JavaScript dependencies and uses host-provided runtime paths, not sibling checkouts.

## Code ownership

| Location | Responsibility |
| --- | --- |
| `index.ts` | SDK startup, surfaces, event dispatch and review/confirmation flows |
| `ui.ts` | Declarative screens, tables, dialogs, quick view and action shortcuts |
| `lib/engine.ts` | Queue, scheduling, safety policy, update/check/rollback orchestration and audit |
| `lib/store.ts` | Managed JSON files, audit rotation and per-job logs |
| `lib/types.ts` | Items, providers, plans, steps and execution context |
| `lib/exec.ts` | PATH discovery, direct command execution, streaming, timeouts and cancellation |
| `lib/version.ts`, `lib/notes.ts` | Version/channel policy and release-note parsing |
| `providers/` | Discovery, checks, plans, notes, recipes and provider-specific rollback |
| `migrate.ts`, `lib/migration.ts` | Managed-data initialization/schema compatibility |
| `scripts/build.ts` | SDK validation, bundling, archives and release metadata |
| `test/` | Provider, engine, migration and unpacked-package behavior |

## Providers and update safety

Providers cover Homebrew formulae/casks, Sparkle apps, runtimes/tools, global packages, git
clones and custom recipes. Runtime/tool providers include Node through nvm, Bun, Deno, uv,
Rust, Go and Claude Code. Package providers include npm, uv tools, pipx and Cargo installs.
Provider contracts define availability, discovery, checking, planning and recipe descriptions,
with optional notes, channels and rollback. Register a provider in `providers/index.ts` and
keep its version/channel and auth requirements in provider code.

Discovery runs only on request. Watching an item opts it into scheduled checks; notification
is the default policy. Automatic software updates require both the global switch and an item
policy, and still pass item/plan safety checks. Passwords, app interaction and unverified
custom commands are excluded from unattended work. Built-in command steps use argument lists;
custom shell recipes require a matching fingerprint of the commands the user reviewed.

The engine runs at most three jobs concurrently. Item/provider groups serialize conflicting
work. Jobs expose live logs and explicit cancellation. Checks use stored deadlines, interval
jitter and failure backoff. Active startup schedules a first tick after three seconds and
subsequent ticks every 30 seconds; the default item interval is six hours. Jobs are in memory;
settings, items, discovered results, audit and logs persist.

Items sharing an identity are linked across providers and rechecked after updates. Bulk
eligibility is shared by the UI and event handler. Sparkle compares bundle versions while
showing marketing version plus build number, so a build-only update retains its release notes.
An update plan is shown before execution, and the installed version is checked afterwards.
Provider rollback is an explicit provider operation; it is not a promise to undo all external
changes or interrupted commands.

## Data and lifecycle

The SDK's `dataDir()` resolves the directory Toolbelt supplies through `TOOLBELT_DATA_DIR`.
Store keeps `items.json`, `settings.json`, `discovered.json`, append-only/rotated `audit.jsonl`
and `logs/<job>.log` there. JSON state writes use temporary files and rename. The engine creates
its password-rejection helper in this managed directory. Package files remain immutable.

Schema 1 uses this file layout. `migrate.ts` calls the SDK migration helper and validates the
requested source/target schemas. Initialization and schema 1→1 are no-ops; unsupported schemas
fail. Toolbelt snapshots managed data, runs migration on a staged copy, probes the candidate,
promotes code/data and commits the active selection after readiness. A failed candidate can
return to the matching code/data selection. These directory operations do not roll back real
apps, tools, repositories or services updated by Upkeep.

`TOOLBELT_LIFECYCLE_MODE=probe` suppresses login-shell startup, scheduling, queue submission and
event handling. A staged candidate can become ready and render its data without checking or
changing external software. Active startup initializes PATH and starts the normal scheduler.

The SDK prepare hook delegates to `Engine.prepareShutdown()`. Any queued or running operation
returns a busy result without cancelling it. Once idle, preparation freezes queue submission
and stops both scheduling timers. The host can then stop the process and safely change the
managed package/data selection. A user can wait for work to finish or explicitly cancel it;
an upgrade itself never cancels real software work.

## Distribution and verification

`toolbelt.json` is the source manifest; the build rewrites its entry to bundled `index.js` and
includes bundled `migrate.js` and `NOTICE`. Per-target `.tar.gz` archives, checksum sidecars and
`toolbelt-release.json` are produced in `dist/`. The descriptor binds source commit, identity,
version, target filenames, sizes and hashes. GitHub release assets are the distribution source;
Toolbelt performs no dependency installation or plugin source build.
The build is local-only. [Release commands](releases.md) prepare a version PR; merging it authorizes CI publication after validation.

Tests use temporary homes, scratch-file recipes and fixture feeds. They cover policy/auth
boundaries, provider parsing, Sparkle builds/notes, queue/cancel/persistence, migration rejection,
safe shutdown and inert probe behavior. Package tests unpack real archives outside the source
checkout and exercise protocol readiness, validated screens, actions, migration and restart
without ambient dependencies. Visual and keyboard checks use the standalone Plugin Tester with
its production renderer and isolated profiles.
