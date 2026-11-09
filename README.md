# Toolbelt Upkeep

Keeps the apps, runtimes, packages and git clones you choose up to date. A plugin for
[Toolbelt](https://github.com/tkarakai/toolbelt).

- **Discover**: scan this Mac (only when you ask) for Homebrew formulae and casks, Sparkle
  apps, Node (nvm), Bun, Deno, uv, Rust, Go, Claude Code, global npm/uv/pipx/cargo packages,
  and git clones, then choose what to watch.
- **Watching**: checks on a schedule (every 6 hours by default) with a live countdown to each
  item's next check and *Check now*. Shows end-of-life warnings and channels (LTS, beta).
  Items can be pinned, have a version skipped, or be rolled back.
- **Review & update**: shows the exact commands and the release notes for every version
  since yours, then runs the update in a queue with live logs and cancel.
- **Activity**: an audit log of every scan, check, update, rollback and setting change.

Nothing is checked or changed until you choose. Updates are notify-only until you turn
automatic updates on. Anything that needs a password, quits a running app, or runs your own
commands never starts by itself. See [docs/design.md](docs/design.md).

Status: first version. It needs a Toolbelt with the protocol additions from
[tkarakai/toolbelt#2](https://github.com/tkarakai/toolbelt/pull/2).
