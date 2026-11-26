# Changelog

## Unreleased
- Requires ToolBelt 0.6.0 or newer (plugin protocol 2); uses SDK 0.4.0.
- Search and filters on Updates, Discover and Activity are the same on every screen (the window,
  the menu bar and paired devices) and ToolBelt remembers them.
- AI agents can read Upkeep (what's watched, updates and activity) through ToolBelt, each with
  its own search and filters that never change what you see. Dialogs stay on your screen only.

## 0.2.0 — 2026-11-15
- Redesigned flow: work you start shows its progress where you started it (a card with live
  progress and the outcome, a pulsing dot on the row, the details panel) and ends with one
  summary of what changed. A toast with **Show** opens the result when you've moved on.
- **Updates** (formerly Watching) groups items by what needs doing: In progress, Needs you,
  Ready to update, Review first, Not checked yet, Up to date and Held back, with a Kind filter.
- Update is one click by default, with **Review & update…** beside it. Apps, major versions,
  passwords, your own commands and vendor updaters ask for a short confirmation first.
  **Update N ready** runs as one batch, with **Review them first…** listing what's included,
  what's left out and why.
- The review dialog stays open after **Update now** and follows the update to its verified
  result; **Run in Terminal** sits beside it.
- **Discover** compares each scan with the previous one: new, gone and changed versions, and
  watched items the scan no longer finds (with Stop watching). **Watch N new** in one click.
- **Activity** replaces the separate Queue: what's running now on top, then history with one
  entry per run and its items nested inside, filterable by what and who started it. Updates
  no longer record a separate "started" entry; the command line is in the job log.
- Scheduled checks are one run each and stay quiet: the badge, the list and Activity show what they found.
- The menu-bar quick view shows live progress, the last outcome and **Update N ready**.
- Requires Toolbelt 0.3.6 or newer (split actions and plugin navigation); uses SDK 0.3.4.
- Release retries are pinned to the exact authorized source, publication is serialized per
  repository and runs the publisher from the trusted workflow commit.

## 0.1.0 — 2026-11-11
- Non-interactive release PR preparation and verified CI publication through the shared SDK release tooling.

- Independently packaged plugin with a pinned public SDK, bundled JavaScript dependencies,
  target release archives, checksums, compatibility metadata and schema-aware migration.
- Discover Homebrew and Sparkle apps, runtimes and tools (Node through nvm, Bun, Deno, uv,
  Rust, Go and Claude Code), global npm/uv/pipx/Cargo packages and git clones, with duplicate
  identities and reversible Watch/Stop watching actions.
- Watching provides scheduled checks, countdowns, channels, end-of-life warnings, pins, skipped
  versions and provider rollback. Reviews show commands and release notes, including Sparkle
  build-only updates; bulk updates exclude items requiring individual review.
- Queue with live logs and cancellation, Activity audit history, custom recipes, keyboard
  action shortcuts and a menu-bar quick view.
- Explicit opt-in and notify-only defaults. Passwords, app quitting and custom commands never
  run unattended. Package unload/upgrade defers queued or running work, and staged probes
  skip login-shell initialization, polling and external actions.
