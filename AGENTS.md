# toolbelt-upkeep — maintenance instructions

Upkeep is a macOS Toolbelt plugin. Read [README.md](README.md) and
[docs/architecture.md](docs/architecture.md) before changing behavior.

## Ownership and contracts

- This repo owns Upkeep's implementation, providers, UI definitions, data schema, migrations,
  dependencies, tests and ready-to-run packages. Toolbelt owns the generic host and renderer.
- Consume the pinned public `@toolbelt/sdk` package. Do not copy SDK source or import from a
  Toolbelt checkout. Change the SDK pin and Bun lockfile together and verify compatibility.
- Keep manifest capabilities, runtime/host requirements, screens and packaged files consistent
  with actual usage. Preserve `upkeep`, its screen IDs and persisted data identities unless a
  change explicitly includes compatibility/migration handling.
- Keep writable state in `dataDir()`. Treat installed package files as immutable. Data-format
  changes require supported-schema declarations and retry-safe migration/recovery tests.
- A staged lifecycle probe must not start login shells, checks, updates or external actions.
  Keep the probe guards and packaged regressions intact.
- Prepare for unload/upgrade must refuse queued/running work, then freeze scheduling and new
  jobs once safe. Never solve a busy upgrade by cancelling a software update automatically.

## Safety

- Never test by updating the person's installed apps/tools or working repositories. Use
  temporary HOME/data/configuration, fake feeds, scratch recipes and throwaway git clones.
- Fresh installs watch nothing; scanning requires a request. Automatic updates are off by
  default and require item policy too. Passwords, app quitting and custom commands never run
  unattended. Keep provider/auth and bulk-update eligibility checks consistent with the UI.
- Built-in recipes execute argument lists. Custom shell recipes are visibly unverified,
  require review of the exact command fingerprint and remain manual.
- Test cancellation only on disposable work. Managed-directory recovery does not undo
  external software changes; preserve that distinction in UI and maintenance guidance.

## Workflow

- Never use the no-mistakes tool, plugin, skill or pipeline. Implement, review, validate and
  operate Git/CI directly.
- One agent per checkout. Stop if `git status` contains changes you did not make.
- Work on a feature/fix branch, never commit directly to `main`. Open a PR and let CI pass.
  The user handles main merges. Do not enable auto-merge or publish stable releases without
  explicit authorization.
- Add user-visible behavior changes to `## Unreleased` in `CHANGELOG.md`. Do not bump versions
  in feature PRs; version changes belong in a release PR. Preserve legal notices/provenance.
- Workflow changes pin actions to full commit SHAs and keep permissions minimal. Allowed
  actions are GitHub-owned actions, `oven-sh/setup-bun` and `zizmorcore/zizmor-action`.

## Checks and packaging

Use Bun: `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run build`.
Do not substitute npm/yarn/pnpm, Node test runners or npx. Run checks appropriate to the change;
for provider/runtime/package changes, run the full checks and exercise the actual archive.

Provider behavior belongs in `providers/` and provider tests; shared safety/scheduling in
`lib/engine.ts`; UI definitions in `ui.ts`; event handling in `index.ts`. Preserve package tests
that execute without a sibling checkout or ambient dependencies. Use Plugin Tester for screen,
quick-view, dialog, keyboard, theme, narrow-layout and lifecycle checks with fake resources.

Follow [docs/releases.md](docs/releases.md) for publication. There is no release script and CI
does not publish. The runbook owns version/tag alignment, frozen assets, draft verification,
native readiness, channel selection and recovery. Never overwrite published version bytes,
execute publisher install/build scripts on the host, or copy this checkout directly into an
installed application's plugin directory.
