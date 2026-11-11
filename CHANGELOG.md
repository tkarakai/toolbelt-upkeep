# Changelog

## Unreleased

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
