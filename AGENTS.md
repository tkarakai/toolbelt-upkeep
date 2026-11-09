# toolbelt-upkeep — notes for coding agents

Toolbelt Upkeep: a [Toolbelt](https://github.com/tkarakai/toolbelt) plugin that keeps what the
person chooses up to date. macOS only. See `README.md` and `docs/design.md`.

## Workflow (required)

- **Never commit to `main` directly.** Branch (`feat/…`, `fix/…`), open a pull request, let CI
  pass, squash-merge. The PR title becomes the commit title on `main`. The `main` ruleset
  enforces this (`.github/settings/`).
- **One agent per checkout.** If `git status` shows changes you didn't make, stop and ask —
  another session may be working here.
- Add user-visible changes to `## Unreleased` in `CHANGELOG.md` in the same PR.
- Don't bump the version in feature PRs; that happens in a release PR.
- Workflow files: pin actions to full commit SHAs, keep `permissions` minimal. Only
  GitHub-owned actions, `oven-sh/setup-bun` and `zizmorcore/zizmor-action` are allowed.

## Safety (required)

- Upkeep updates real software. Never test by updating the person's own apps or tools. Use
  `TOOLBELT_CONFIG_DIR` pointing at a scratch folder, and exercise updates with a custom recipe
  or a throwaway git clone.
- Keep the rules in `docs/design.md`: nothing runs before the person opts in; anything needing
  a password, quitting an app, or running their own commands never runs unattended; built-in
  recipes are argument lists, never shell strings.

## Bun

- Use `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>` — not node,
  jest/vitest, npm/yarn/pnpm or npx.
