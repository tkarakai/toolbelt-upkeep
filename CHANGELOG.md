# Changelog

## Unreleased

- Architecture v2: independently packaged plugin with pinned public SDK, ready-to-run
  release archives and hashes, schema-aware migration and safe unload/upgrade deferral.
  Preserves shipped Sparkle build updates, keyboard shortcuts and Discover watch toggles.
  Staged candidate probes never start polling or software-update jobs.
  Direct copying into an installed official Toolbelt profile has been removed.

- First version, moved here from the Toolbelt repository: Discover (Homebrew, Sparkle apps,
  Node via nvm, Bun, Deno, uv, Rust, Go, Claude Code, global npm/uv/pipx/cargo packages, git
  clones; duplicates flagged), Watching (scheduled checks with countdowns, end-of-life,
  channels, pin, skip, rollback), Review & update with every release note since your version,
  Queue with live logs and cancel, Activity audit log, custom recipes and a menu bar quick view.
  Nothing runs before you opt in; password, app-quitting and your own commands never run
  unattended.
