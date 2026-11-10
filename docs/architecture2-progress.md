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

Current verification: frozen dependency install, TypeScript check and all 46 tests pass
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

Additional packaged lifecycle regression starts an explicit scratch-file update, observes
prepare refusal while busy, verifies the update finishes without interruption, then observes
prepare readiness. Evaluation prerelease `architecture2-eval-5380065` pins implementation
commit `5380065351b66c0305116549c99c69c0c90202d9`; both target archives are 34,517 bytes
with SHA-256 `94a8a376eb62eab483cd533226e31fca07dad6cc119aa3fabccd7a86cc39293a`.
Draft assets were downloaded and checked against the descriptor before prerelease publication.

## Real host/GitHub integration

The first published macOS archive carried pax extension metadata and the production
installer correctly rejected it. Packaging now explicitly uses ustar and disables macOS
copyfile metadata. No existing release asset was overwritten.

Current candidate: `architecture2-eval-20be059`, source
`20be05905e09dc0e7445f16b6f94080c95ffc9cd`:
`https://github.com/tkarakai/toolbelt-upkeep/releases/download/architecture2-eval-20be059/toolbelt-release.json`.
Both macOS target archives are 33,878 bytes, SHA-256
`c5ca2835add9d98e87416129266e2d2a3174c286c7634505c46cadbafa856c98`.
Downloaded draft bytes were checked against source commit/hash/size before publication as
an explicit prerelease (`latest=false`). The earlier candidate is superseded for evaluation.

Read-only imports of the current Toolbelt `PackageManager`, `resolveGithub` and `PluginHost`
were exercised against that public GitHub prerelease in a temporary profile and HOME, with
`SHELL=/usr/bin/true`. Passed: real release lookup/download/hash validation, initial migration,
staged probe, final ready, all six SDK-validated surfaces, explicit scratch recipe review and
update, refusal to disable while that update ran, completion without interruption, runtime
disable/re-enable/removal, and default data retention. No app restart was used. This caught
and coordinated a host fix to buffer startup badges until ready; pre-ready trees still reject.

Native renderer screenshots, mouse/keyboard shortcuts, themes and menu-bar positioning
remain shared tester acceptance work. The above is a genuine production-host/package test,
not a visual acceptance claim.

An additional production-host regression checks **package install during active work**,
not only disabling: while an explicitly reviewed scratch recipe update was running,
`PackageManager.install(candidate, true)` refused the upgrade. The original Upkeep PID
remained unchanged (observed 53243 before and after refusal), and the same update completed
to 1.1.0 uninterrupted. Runtime disable/re-enable/remove and retained data then passed.
This verified the coordinated host guard that avoids stopping the old plugin when its
prepare hook refuses. No Toolbelt implementation is imported by this repository's tests;
the bounded cross-repo extraction check used a separate temporary integration script.

## Native tester acceptance

The standalone native tester was copied out of its source checkout into a temporary HOME
and launched there with embedded Bun, isolated packages/data/settings and debug port 47841.
Its own app identity is `io.github.tkarakai.toolbelt.tester`; no official app was replaced.
The installed plugin was the downloaded/hash-verified public evaluation archive, not source.
Only disposable custom recipes, a fake Sparkle app Info.plist and a local appcast were used.

Verified through the production renderer and native keyboard/mouse controls:

- All five screens plus simulated and real native quick view.
- Alt+Cmd+1–5 navigation, repeated Discover Enter Watch/Stop watching, U review and L logs.
- Sparkle same-marketing-version build 101→102 display, matching build-only release notes
  and the full-notes link; the Open/update action for the fake app was never executed.
- Explicit review and Return runs only the scratch recipe; live Queue/logs, verified
  scratch version 1.0.0→1.1.0 and persisted Activity/log dialog all rendered correctly.
- Light/Graphite and dark/Nord themes; Cmd+ zoom to 110%, Cmd+0 reset; reduced motion
  forces zero transition duration. Icons render (30 SVG elements), no broken images.
- Native Edit select-all/copy/paste in the archive path field and actual archive selection,
  publisher entry/approval and Open archive control return Upkeep to running.
- Cmd+, opens shared Settings. Corrected tester frame and sidebar heights fit the available
  727px area, including the footer. Actual native viewport 414px renders readable Name-only
  table rows without document overflow or the earlier left clipping.
- Real native list is 380×145; clicking Upkeep opens its 380×520 quick view. Escape returns
  to list and another Escape hides after the closing animation. Initial invalid tray bounds
  now use a visible work-area fallback; later actual tray bounds anchor the popover normally.

Pixel evidence is retained under `docs/evidence/architecture2-native/`. During testing, host
issues (startup badge ordering, ustar metadata, tester frame sizing, native Edit menu and
initial invalid tray geometry) were found, fixed by the host owner and retested. Native
popover is a layer-3 window excluded from Orca's default window listing; own-PID CoreGraphics
metadata supplied its exact window ID for successful targeted ScreenCaptureKit captures.

Direct native blur was verified with the final shared tester `activateMain` hook: activating
the main window without calling hide made the popover report `visible:false` through its
real blur/closing path. Escape close and explicit navigation close are also verified. Full multi-display positioning remains human/environment
acceptance, not claimed from this single-display fixture pass. All own tester instances
were closed after each pass, with PIDs and debug-port closure checked.

## Probe startup safety

Lifecycle probe startup now skips login-shell initialization and freezes the engine queue
without starting either scheduling timer. A staged candidate must not check opted-in items
or reach automatic software updates before promotion. Packaged regression renders all six
surfaces with overdue items, attempts Check all, waits past the normal three-second startup
tick, and verifies no audit/check state or queued/running work changed. Active final startup
retains the normal scheduler. Schema 1 migration still affects only host-staged data.

Probe-safe candidate: `architecture2-eval-c8d8c1f`, source
`c8d8c1f32412a5a4221e0e608a398404a7ec7c3d`:
`https://github.com/tkarakai/toolbelt-upkeep/releases/download/architecture2-eval-c8d8c1f/toolbelt-release.json`.
Both targets are 33,987 bytes, SHA-256
`4ab77de0088caaff7dcb034fe63ace2d1926ed4a210c98fc25a309c7aa596a19`.
Draft assets were downloaded and verified before prerelease publication (`latest=false`).
Use a fresh isolated evaluation profile: immutable same-version changed-byte rejection
correctly prevents replacing an earlier development candidate silently. The old SDK 0.2.0-dev.1
remains pinned and compatible; probe mode is conveyed through the public lifecycle environment.

Current validation: typecheck and 47 tests pass. The shell-init probe regression uses an
executable scratch shell that creates a marker: probe startup does not invoke it, while
active startup does, proving the fixture detects that external startup path. Public GitHub
resolve/install with the latest host and this candidate again passed initial migration,
staged/final readiness, all six surfaces, refusal of install while a scratch update ran
(original PID 62528 unchanged), uninterrupted completion, disable/re-enable/remove and
retained data. Native screenshots cover the same rendering/runtime contract; the subsequent
probe guard changes no UI definitions.

Final native smoke used the exact probe-safe `c8d8c1f` archive (SHA-256 `4ab77de0088caaff7dcb034fe63ace2d1926ed4a210c98fc25a309c7aa596a19`) in a fresh
`upkeep-final-c8d8` profile with namespaced browser state. All five native Alt+Cmd tab
shortcuts returned their declared screens, the real 380×520 quick view rendered, and
activating main triggered native blur-close. Actual 414px viewport table bounds were
x=1..413 with zero document overflow. Final native/narrow screenshots are retained with
the earlier parity captures. Both the native Bun PID and its own extraction launcher were
checked and cleaned; no user app was closed. The final tester packaging now extracts/signs
the real application instead of distributing that self-extractor wrapper.

## Disposable real app updater rehearsal

A full working-file copy of the Toolbelt feature checkout was staged outside Git, with its
own build lock, HOME, configuration, temporary directory and disabled global shortcut.
Only temporary package versions were changed: 0.1.0 and 0.1.1; no version change was committed.
Both native app versions were built from that copy. The newer real app was packed with
Toolbelt's own DMG builder, ad-hoc signed, mounted and checked for bundle id/version and
strict code signature. A localhost GitHub-shaped feed served the DMG with a SHA-256 digest.
The signed old real app was copied into the disposable installation directory. No official
installation, public feed, stable release or user-owned process/data was changed.

Production debug APIs and real renderer controls exercised the actual updater (no mocked
fetch, shell, codesign, mount, copy, swap or relaunch):

1. An enabled disposable plugin declaring `>=0.1.0 <0.1.1` blocked the target host update
   before any DMG download. The old app remained PID 19735/version 0.1.0.
2. After disabling that fixture, an explicitly reviewed 20-second Upkeep scratch update
   ran while the holder downloaded/verified/mounted/copied the new app. Prepare refused
   replacement while Upkeep was busy. App PID 19735 and Upkeep PID 19743 were unchanged;
   the scratch operation completed 1.1.0 uninterrupted. The old bundle remained 0.1.0 and
   no staged replacement directory remained. This verified the new shared app-upgrade
   preparation/gating/resume path, not just plugin-package preparation.
3. A deliberately incorrect SHA-256 caused the real download to fail verification. Old
   app PID 47224/version 0.1.0 remained intact.
4. With the correct digest, the real 34,039,853-byte DMG downloaded, mounted and passed
   metadata/signature checks, then atomically replaced the app and relaunched through
   `/usr/bin/open`. PID 51557/version 0.1.0 became PID 53053/version 0.1.1 in 5,860 ms.
   The installed bundle's short version and strict signature passed; compiled application
   code changed. A harmless installed environment fixture running under the NEW host
   confirmed temporary HOME, `/usr/bin/true` shell and host version 0.1.1 survived relaunch.
   Upkeep re-enabled on the new host and displayed its retained scratch version 1.1.0.

Final DMG SHA-256: `0f8ac00425815fa9b63aca4752575be5db3c4df1a74b4c4c16579286af66fc92`.
The full phase timings, source file hashes, environment proof and cleanup record are retained
in `docs/evidence/architecture2-native/updater-rehearsal.json`. Reproducible fixture/driver/feed
scripts and the staged build state remain in the bounded `/tmp/toolbelt-updater-*` test
artifacts; their only external inputs were the copied feature source and pinned packages.
The app updater's relaunch environment whitelist was corrected during this rehearsal so
an isolated HOME/SHELL cannot fall back to the real user's shell startup files.

All own app, plugin, launcher and fixture-server PIDs were stopped; ports 47841, 47851,
47852 and 50329 closed; no own disk-image mount, updater work directory or staged old app
remained. Only the two disposable app paths were unregistered from Launch Services.
Electrobun logged nonfatal install-record bootstrap warnings for these unregistered temp
app copies; Toolbelt's actual update, retained profile, signature and native relaunch checks
passed. OS installation/bootstrap registration itself is outside this rehearsal's claim.
