# Architecture v2 implementation evidence

## Baseline and ownership

Source baseline: `tkarakai/toolbelt@229bd64b20599f621589e03e17d36ee72c604ff5`.
The repository began at `5ee37e24b766f690aed005ae2f3863ad2b86eaf4`; its existing
implementation and tests were reconciled with the complete shipped plugin. Branch history
was inspected for subsequent plugin changes; the current shipped baseline includes all
known fixes (later branch entries duplicate already merged commits).

Reconciled files: `index.ts`, `ui.ts`, `lib/engine.ts`, `providers/sparkle.ts`,
`test/providers.test.ts`, and `toolbelt.json`. The remaining engine/provider/store/version
files and existing tests were byte-identical to the shipped baseline. No provider logic
was rewritten. Authorship remains in this repository's original implementation history;
the additional fixes originated in Toolbelt PRs #10, #12 and #13.

Preserved parity: Watching, Discover, Queue, Activity, Settings and quick view; Sparkle
bundle-number ordering and build-only release notes; reversible Watch/Stop watching;
keyboard action keys; common bulk-update eligibility; explicit opt-in and notify-only
defaults; custom command fingerprint review; audit/log persistence, cancel and rollback.

## Lifecycle

Upkeep owns schema 1, the unchanged existing files. Initialization and same-schema upgrades
are explicit no-ops; unknown schemas reject. The host stages/snapshots the managed directory.
External software mutations are never represented as recoverable by a directory rollback.

Prepare for unload/upgrade refuses while any queued or running operation remains. It never
aborts an operation on behalf of a package upgrade. Once ready it stops both scheduler
timers and rejects new queue entries, preventing a timer race during shutdown. Rejected
prepare leaves the engine running normally; the user can wait or explicitly cancel jobs.

## Verification

Initial baseline: 38 existing unit/provider/version tests pass. New regression coverage
checks bulk eligibility, lifecycle deferral without cancelling a harmless scratch-file
update, scheduler quiescence, and schema compatibility. Tests use disposable folders and
custom recipes, never installed software updates. Package/SDK and visual evidence follows
once the coordinated public tester candidate exists.

SDK candidate: `@toolbelt/sdk@0.2.0-dev.1`, source
`tkarakai/toolbelt@dec484841a858d94b8cd0d0e02c20b9eb062db3a`, pinned release asset:
`https://github.com/tkarakai/toolbelt/releases/download/sdk-v0.2.0-dev.1/toolbelt-sdk-0.2.0-dev.1.tgz`.
SDK archive SHA-256: `712610f41c9e049274985d5dbad23dfb7d59a72c4c0aaff3b7c1aca3dc6dd68e`.

Current verification: frozen dependency install, TypeScript check and all 45 tests pass
on Bun 1.4.2/macOS arm64 (CI pins Bun 1.4.4). Package tests build both macOS target archives,
check descriptor SHA-256/size, unpack outside the source tree with no node_modules, and
exercise all six rendered surfaces with SDK runtime message validation. The same package
test covers repeated Discover Watch/Stop watching, explicit opt-in defaults, review,
scratch-only software update, audit/log persistence, restart and prepare readiness.
Packaged migration initializes/retains schema 1, retries unchanged and refuses schema 2
without modifying staged content. No installed software or official profile was used.

Visual/native tester checks remain pending the shared Toolbelt tester candidate; this is
not yet a claim that every cross-repo architecture exit gate is complete. Final plugin
archive hashes/source commit are in the generated release descriptor and the handoff.
