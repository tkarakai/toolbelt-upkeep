# Upkeep architecture

Upkeep owns its screens, providers, software-update engine, data schema, migrations, tests and
release packages. Toolbelt owns rendering, plugin package installation, runtime processes and
managed-data recovery. Upkeep's software-update queue is separate from Toolbelt's plugin-package
update manager.

## Runtime and UI

Toolbelt launches the bundled entry with its Bun runtime in an independent process. The plugin
uses the public `@toolbelt/sdk` package and bounded JSON-lines messages over stdin/stdout; stderr
is diagnostic output. UI is a declarative tree rendered by Toolbelt, without plugin browser
JavaScript. The manifest declares format/protocol versions (protocol 3), compatibility,
capabilities, surfaces and agent access. SDK build version is diagnostic rather than an exact
host-version match.

The stable plugin id is `upkeep`. Screens are `monitored` (titled Updates), `discover`,
`activity` and `settings`, with a `quick` surface for the menu bar. The former `queue` screen was
removed; running work is the top of Activity. `plugin.ts` (`createUpkeep`) handles lifecycle and
events and connects the SDK to Store and Engine; `index.ts` runs it with the SDK's `dataDir()`. `ui.ts` builds the screen trees, action keys, forms, run cards,
review/bulk/log/history dialogs and quick view.

Each screen's search and filters are an SDK *view*, declared in `VIEWS` (`ui.ts`): Updates has
search and the `kind` filter, Discover search, Activity search and the `what`/`by` filters, all
starting unfiltered. The SDK applies `search`/`filter` events, keeps one view per open instance
and passes it to the screen functions, which render from engine state plus that view and nothing
else. Toolbelt saves the person's view, so Upkeep persists none. Every person's screen (window,
popover, paired devices) shares the `PERSON` instance; AI agents read and act through `agent:…`
instances with views of their own (manifest `agent.access: "act"`). Filter option values (`kind`,
`what`, `by` keys) are the agent-visible view schema: keep them stable.

Every action id the trees and toasts use, and every form, is declared in `ACTIONS`/`FORMS`
(`ui.ts`) with its effect; ToolBelt rejects a tree with an undeclared id and asks the person
before an agent's change as the effect requires. Updates, rollbacks, cancellations and
**Run in Terminal** are `external`; Stop watching (`remove`, `remove-many`) is `destructive`;
checks, scans, watching, skips, pins, settings and recipe saves are `write`; dialogs and
navigation are `view`. **Run in Terminal** and the recipe review (`review-recipe`,
`recipe-approve`) are `agent: false`. Automatic updates are switched on by the confirmed
`auto-updates-on` action, not a form field, so an agent's request always asks. The row's
`update*` id names its confirmation (`updateActionFor`); the handler refuses any id other than
the one `offeredUpdate` gives the row now. Handlers return started run and job ids in the
result's `data` (`{ run, jobs }` or `{ run, job }`), the added recipe's id with whether it was
reviewed, and the ids a batch left out.

Events carry their `origin`. An agent's are handled like the person's, recorded with `by:
"agent"` (Activity's "An agent"), and never mark a custom recipe reviewed: such a recipe isn't
checked or run (`runnable`) until the person opens **Review its commands…** and allows it. A
thrown error is the event's result error; for the person it's also a toast.

Dialogs (with their drafts) and run-card dismissal live in plugin memory, per instance: every
person's screen shares the `PERSON` dialog, drawn on the screen it was opened on, and each
agent instance has its own, dropped when that instance closes. Opening, closing and navigation
happen only in `onEvent`. Per-instance `onOpen`/`onClose` track which surfaces the person has
open: a finished run's toast is skipped only when the person is looking at its card (or
following it in their review dialog), so work an agent started still reaches the person.
Toolbelt owns renderer selection, scroll and other immediate UI state.

Every request is a *run* (`Engine.startRun`/`batch`): a scan, "check all", a batch of updates, one
update or one scheduled tick. Its jobs carry the run id, and when the last one ends the engine
summarizes it (`summarize`) and, for runs of several jobs, records one `run` audit entry. The
surface that started a run shows a card with its progress and outcome; rows show a pulsing
status dot; the review dialog follows an update it started. When the card isn't in view, a
toast offers **Show**, which uses SDK navigation (allowed by the host only right after a user
event) to open the outcome. A single status function (`statusOf`) decides an item's group, dot
and actions; `reviewReason`/`updateActionFor` keep row confirmations consistent with bulk
eligibility. Scans store a comparison with the previous scan (`ScanDiff`) in `discovered.json`.

Required capabilities are `ui.core`, `ui.action-key`, `ui.split-action`, `navigate` and
`lifecycle`. `toolbelt.json` declares
supported host/Bun ranges, macOS targets and data schema support. The package bundles its
JavaScript dependencies and uses host-provided runtime paths, not sibling checkouts.

## Code ownership

| Location | Responsibility |
| --- | --- |
| `index.ts` | Runs the plugin definition with the SDK's data folder |
| `plugin.ts` | SDK lifecycle, surfaces, per-instance dialogs, event dispatch and review/confirmation flows |
| `ui.ts` | Action and form declarations, declarative screens, tables, dialogs, quick view and action shortcuts |
| `lib/engine.ts` | Queue, runs and summaries, scan comparison, scheduling, safety policy, update/check/rollback orchestration and audit |
| `lib/store.ts` | Managed JSON files, audit rotation and per-job logs |
| `lib/types.ts` | Items, providers, plans, steps and execution context |
| `lib/exec.ts` | PATH discovery, direct command execution, streaming, timeouts and cancellation |
| `lib/version.ts`, `lib/notes.ts` | Version/channel policy and release-note parsing |
| `providers/` | Discovery, checks, plans, notes, recipes and provider-specific rollback |
| `migrate.ts`, `lib/migration.ts` | Managed-data initialization/schema compatibility |
| `scripts/build.ts` | SDK validation, bundling, archives and release metadata |
| `test/` | Provider, engine, migration, fake-host plugin and unpacked-package behavior |

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
settings, items, discovered results (with the last scan comparison), audit and logs persist.
Audit entries may carry an optional `run` id, and runs of several jobs add a `run` entry; both
are additive to schema 1, and older `started` entries are hidden in Activity.

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
without ambient dependencies, plus SDK-applied search/filters, event results, independent agent
instances and an agent's unreviewed recipe. `test/plugin.test.ts` runs the plugin under the SDK's
`fakeHost` (declarations, rendered ids, result data, the update-id check, confirmations,
per-instance dialogs and toasts) with a fake provider. Visual and keyboard checks use the standalone Plugin Tester with
its production renderer and isolated profiles.
