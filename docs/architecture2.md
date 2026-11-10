# Architecture v2 — Upkeep implementation handoff

Status: planning only. Branch: **feat/architecture2**. No implementation in this commit.

## Read first

The [Toolbelt architecture v2 specification](https://github.com/tkarakai/toolbelt/blob/feat/architecture2/docs/architecture2.md) is the cross-repository source of truth.
[Initial committed specification](https://github.com/tkarakai/toolbelt/blob/2ae4ff3a4ea4e5fb51dcd65480bf700cfe27f99c/docs/architecture2.md).
Read it completely before implementation; this role summary does not replace the package,
compatibility, runtime lifecycle, migration, tester and acceptance contracts.

Do not merge to main, enable auto-merge, publish stable releases, overwrite the user's
working app/data, update their software, or delete the legacy Running repo. The user will
assign implementation separately. Never use the no-mistakes tool/plugin/pipeline.

## Starting points and preservation

This branch starts at 5ee37e24b766f690aed005ae2f3863ad2b86eaf4, the original implementation
on origin/feat/upkeep. At planning time origin/main is only the bootstrap commit.
Do not merge the old implementation PR merely to establish a migration base.

The CURRENT parity source is tkarakai/toolbelt at
229bd64b20599f621589e03e17d36ee72c604ff5, particularly plugins/upkeep/ and
test/upkeep-integration.test.ts. Inventory any newer changes before extraction.

Reconcile current Toolbelt patches into this repository; do not overwrite them with this
older feature branch:
- Correct manifest/design references.
- Shared bulk-update eligibility: exclude apps requiring individual review, major upgrades,
  blocked/auth-required items; preserve original opt-in and notify-only defaults.
- Discover Watch/Stop watching behavior, including repeated Enter.
- PR #12: Sparkle compares bundle versions and exposes build numbers, and includes notes
  for build-only updates plus full-release-note links. Preserve real rebuild updates;
  do NOT hide them just because marketing versions are equal.
- PR #13: Watching/Discover/Activity table shortcuts and hints. Obtain Action.key from
  the shared SDK rather than maintaining a vendored protocol fork.
- All existing provider/engine/version tests and bundled integration behavior.

Upkeep's software-update queue is unrelated to Toolbelt's plugin-package update manager.
Do not combine them. Toolbelt must understand no Upkeep providers or recipe semantics.

## Owned implementation after extraction

All Upkeep screens, providers, scheduling, version logic, audit/queue/review/settings,
migration implementations, assets, dependencies and behavior tests belong here.
Consume the public versioned Toolbelt SDK; remove duplicated vendored SDK/protocol source
once the SDK provides current capabilities. No Toolbelt source-relative imports.

Produce a complete ready-to-run package on this repo's GitHub releases with its manifest,
bundled executable JS, assets/payloads, target/runtime compatibility, source commit and
checksums. Toolbelt downloads and validates; it must never build this source or install
dependencies. Source/debug files may accompany the package but are not build inputs.

## Migration and lifecycle responsibilities

Upkeep owns its schemas and migrations and declares data versions in package metadata.
Toolbelt handles snapshots/staging/transactions; Upkeep reports migration progress/failure/
completion and supports retry-safe migrations of managed data.

Implement prepare-for-upgrade/unload behavior that can defer a plugin upgrade while a
real software update is in an unsafe state. Killing a plugin during a provider update
is not a valid generic upgrade strategy. Cancellation boundaries must be explicit.
Keep provider external side effects separate from plugin data migration; generic rollback
of a directory does not undo an app/tool upgrade.

Use stable id upkeep, preserve screen IDs and renderer state/data paths. Never silently
point architecture2 development at the current official Upkeep's real data. Validate
migration using COPIES in explicitly isolated development/test profiles.

## Test and evidence responsibilities

Behavior tests live here: providers, polling/backoff, channel/EOL/version logic, bulk update
eligibility, review/notes, auth requirements, queue/cancel, audit/persistence and migrations.
Use the shared SDK fake-host tests plus the released visual Plugin Tester for all screens,
dialogs, shortcuts, assets and quick view.

Disposable fixtures mean fake feeds, temporary homes, scratch recipes and throwaway git
clones/processes, NOT the tester application and NOT real software on this Mac.
Keep automatic updates off by default; no monitoring before opt-in and no unattended auth,
app quitting or custom commands. Test those safety boundaries without real updates.

Record extraction inventory, baseline source, candidate package hashes, required SDK/tester
versions and complete parity evidence. Toolbelt tests its generic lifecycle/contracts;
it must not keep a duplicated Upkeep engine/provider test suite or implementation.
Once separately assigned, record cross-repo progress under Toolbelt's
docs/architecture2-progress.md and keep all work on feat/architecture2.

