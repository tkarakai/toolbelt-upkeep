# Upkeep: keeping everything on this Mac up to date

Upkeep is a Toolbelt plugin. You choose what it watches (apps, runtimes, global packages, git
clones, your own recipes). It checks for new versions on a schedule, shows what's new since the
installed version, and updates when you say so, logging every step.

Status: first version, 2026-11-09. It relies on protocol additions in Toolbelt (`card`,
`log`, `progress`, `markdown`, dialogs, bulk actions, relative times, a data folder per
plugin: [tkarakai/toolbelt#2](https://github.com/tkarakai/toolbelt/pull/2)). See
[Known limits](#known-limits-of-the-first-version) for what isn't done yet.

## Principles

1. **Nothing happens until you opt in.** A fresh install watches nothing. Scanning runs only when
   you click *Scan this Mac*, and checks only cover what you added. Updates are *notify only*
   until you turn on automatic updates for an item, and also turn on the global switch for them
   (off by default).
2. **If it needs you, it waits for you.** Anything that needs a password, quits an app, or has an
   unreviewed command never starts by itself. Upkeep points it out and you start it while you're
   there. Unattended runs have no way to ask for a password, so an unexpected prompt fails fast
   instead of hanging (see [Passwords](#passwords-and-other-confirmations)).
3. **Show the exact commands.** Every update plan is a list of commands, shown before it runs and
   recorded after. Built-in recipes run their commands directly as argument lists, never
   through a shell.
4. **Be suspicious of anything not built in.** Upkeep runs your own commands only after you've
   reviewed that exact text. They're marked *unverified*, and they never run automatically.
5. **Use the vendor's own updater.** Upkeep runs `brew upgrade`, `bun upgrade`, `rustup update`
   and the like rather than downloading and installing binaries itself. Those tools check their
   own signatures and checksums.
6. **Everything is recorded.** Every check, update, setting change and failure goes in an
   append-only audit log that you can read on the *Activity* tab.

## What it watches

Upkeep is built from **providers**, one per update mechanism. Each provider can:

```ts
discover()               // what it can find on this Mac (only when you scan)
check(item)              // installed version, newest version, channel, end-of-life
notes(item, from, to)    // release notes for every version after `from`, up to `to`
plan(item, target)       // the exact commands, plus what they need (password, quitting an app…)
verify(item)             // the installed version after an update
```

An item's **recipe** is its provider plus that provider's settings (the cask token, appcast URL,
repository path, and so on). It's saved when you add the item, and both the check and update
commands are shown in its details.

| Provider | Finds | Newest version from | Updates with |
|---|---|---|---|
| Homebrew | formulae and casks (`brew info --installed --json=v2`) | `brew update` + `brew info` | `brew upgrade [--cask] <name>` |
| Sparkle apps | apps whose Info.plist has `SUFeedURL` | the appcast | the app's own updater (opens the app), or Homebrew if it's a cask |
| Node (nvm) | `~/.nvm` versions, the default alias | nodejs.org/dist/index.json (LTS flags) | `nvm install <v> --reinstall-packages-from=<old>` + `nvm alias default` |
| Bun, Deno | `bun`, `deno` on PATH | GitHub releases | `bun upgrade`, `deno upgrade` |
| Rust | `rustup` toolchains | `rustup check` | `rustup update <toolchain>` |
| uv | standalone `uv` | GitHub releases | `uv self update` |
| Go | `/usr/local/go` | go.dev/dl JSON | needs a password: you download the official package |
| Claude Code | `claude` | npm registry | `claude update` |
| npm globals | `npm ls -g` | npm registry | `npm install -g <pkg>@<version>` |
| uv tools, pipx | `uv tool list`, `pipx list --json` | PyPI | `uv tool upgrade`, `pipx upgrade` |
| Cargo installs | `cargo install --list` | crates.io | `cargo install <crate>` |
| Git clones | repos with a remote under your code folders | `git fetch` | `git merge --ff-only @{u}`, only if clean, on its tracking branch, not diverged |
| Custom recipe | — (you add it) | your version commands | your update command (unverified, always manual) |

Later: macOS (`softwareupdate -l`, updated in System Settings), App Store apps (receipt + Apple
lookup API, updated in the App Store), Electron apps (`app-update.yml` → `latest-mac.yml`),
VS Code/Cursor extensions, Ollama models, Docker images, shell and editor plugin managers,
Toolbelt and its own plugins.

### The same thing installed more than once

One tool can have several installers, sometimes on purpose and sometimes by accident: Node from
nvm *and* Homebrew, uv standalone *and* from brew, Docker as a cask that also updates itself.
Upkeep doesn't guess which one "owns" a tool. It shows the tool under **every provider that can
update it**, and you can add each one. Items that share an identity (the bundle id for apps, the
executable name for tools) are linked:

- each shows *also installed via …*;
- the one your PATH runs is marked *active*;
- after one updates, its siblings are re-checked;
- the discovery list flags duplicates, because a forgotten second copy is often the one that's
  out of date.

## Versions, channels and end of life

- **Every version since yours.** Release notes cover every version after the installed one, up
  to the target, newest first. Sources:
  - GitHub releases (via `gh` when it's signed in, which has a higher rate limit, otherwise the
    public API; responses are cached for an hour);
  - every item in a Sparkle appcast;
  - `git log HEAD..@{u}` for clones;
  - the npm or PyPI registry linking to the repository's releases.
- **Channels** come from what's installed: a `-beta`/`-rc`/`nightly` version, a Sparkle
  `<sparkle:channel>`, a GitHub pre-release, rustup's `beta`/`nightly` toolchains, Node's
  LTS vs Current lines. Upkeep stays on your channel unless you change it. For Node it offers
  *same major* (the default), *latest LTS* and *current*.
- **End of life** comes from [endoflife.date](https://endoflife.date) for runtimes (Node, Go,
  Python, Ruby…). It appears as *EOL in 40 days* or *EOL*, and an end-of-life version ranks above
  a plain *update available*.
- **Major updates** are flagged, and automatic updates never take one unless you choose *all
  updates* for that item.
- **Pin** keeps an item at its version. **Skip this version** ignores one release and still
  offers the next.

## Checks, schedule and attempts

- One interval for everything, every 6 hours by default (Settings). Each item can override it.
- Each item stores `checkedAt` and `nextAt`. The schedule runs on those timestamps, not on a
  timer, so checks missed while the Mac slept or Toolbelt was closed run soon after it's back.
  Polls get ±5 % jitter so they don't all fire at once.
- **Check now** works per item, per selection, and for everything.
- Every attempt is recorded: when, how long, the outcome, and the error. Each item shows its last
  check and a live countdown to the next one.
- After failures, retries back off: 15 minutes, 30, 1 hour… up to the normal interval. The
  failure count is shown.
- Toolbelt has to be running for scheduled checks. A launchd agent that runs the checks headless
  (`tb upkeep check --json`) is a later step.

## Updating

Click **Review & update** to open a dialog with:

1. the version change (`2.50 → 2.52`), marked *major* or *pre-release* where it applies;
2. warnings: needs your password, will quit the app, the custom command is unverified, a version
   in between was pulled, end of life;
3. **What will run**: the exact commands;
4. the release notes for every version in between.

**Update now** puts the job in the **Queue**. Jobs run one at a time per provider (Homebrew has a
lock) and a few at once overall. Each job has a timeout, can be cancelled, and streams its output
live. Then:

- **Before:** conditions are checked. The app isn't running, or you've agreed to quit it. A clone
  is clean and on its tracking branch. There's free disk space. For automatic runs: on AC power
  and outside quiet hours.
- **After:** the version is checked again. The update counts as a success only if it reached the
  target. For apps, the Team ID in the code signature must be the same as before. A mismatch
  shows as a red warning in the log.
- **Rollback** where the provider can do it: Node switches the default back to the previous
  version, which stays installed; a git clone goes back to the previous commit
  (`git reset --keep`). Others show what you'd need to do.

Automatic updates, once you turn them on, apply only within the item's policy (*patch*,
*minor*, *all*). They skip anything that needs a password or would quit a running app. They run
after a scheduled check finds an update.

## Passwords and other confirmations

Some updates need administrator rights: macOS, casks that install a `.pkg`, the Go installer.
They are never attempted unattended. They're marked *needs you* and wait until you start them.
When you do, there are four ways to authorize them, from most to least preferred:

1. **Hand over to the vendor's UI.** macOS updates open System Settings › Software Update. App
   Store apps open the App Store. Sparkle apps open the app, which shows its own update window.
   macOS asks for the password, and Upkeep never sees it. After you're done, Upkeep checks
   again.
2. **The native password dialog, through `sudo -A`.** Upkeep sets `SUDO_ASKPASS` to a small
   helper script. When the tool calls `sudo`, the helper shows a macOS password dialog that
   names the item and the exact command. Homebrew passes `-A` itself whenever `SUDO_ASKPASS` is
   set, so this covers casks with installers. The password goes from the dialog to `sudo`
   through a pipe and is never stored or logged. Upkeep runs `sudo -k` afterwards so the sudo
   session doesn't linger.
3. **The system authorization dialog.** For a single command that must run as root (`installer
   -pkg …` after Upkeep has downloaded the package and checked its checksum),
   `osascript -e 'do shell script "…" with administrator privileges'` shows macOS's own admin
   prompt. It isn't used for Homebrew, which refuses to run as root.
4. **Run in Terminal.** Upkeep opens Terminal with the command, you run it and type the password
   there, and Upkeep follows its output from a log file. This is the most transparent option and
   always available as a fallback.

Unattended runs set none of these up, and every command's input is closed. If something
unexpectedly asks for a password, it fails at once ("a terminal is required…") rather than
hanging. Upkeep recognises that, marks the item *needs you*, and records it.

Quitting a running app is the same kind of confirmation: the update dialog says it will quit the
app, and automatic updates leave running apps alone.

## Security

- Built-in recipes are argument lists, run without a shell, with executables resolved to full
  paths when the item is added. No `curl | sh`.
- Custom recipes are shell commands you write. They're shown in full, stored with a hash, and
  editing one makes it unreviewed again. They only run manually, from the review dialog.
- Upkeep doesn't download binaries itself in v1. Delegating to Homebrew, rustup, `bun upgrade`
  and the others means their signature and checksum checks apply. For Go, Upkeep opens
  go.dev's download page. Downloading the package itself and checking it against go.dev's
  published SHA-256 is a later step.
- Release notes are untrusted text. Markdown is shown with links but never raw HTML, and only
  `http`, `https` and `mailto` links open, in your browser.
- Code signatures are compared for apps. Repositories are only fast-forwarded, so local work is
  never rewritten.
- Network calls go to the vendors' own endpoints (Homebrew, GitHub, nodejs.org, go.dev, the npm
  registry, PyPI, crates.io, endoflife.date, appcast URLs), and requests identify themselves
  generically.

## Screens

- **Monitored** (the default): your items, grouped by kind.
  - Columns: installed, newest, last check, next check (a countdown), policy.
  - Chips for *major*, *EOL*, *needs you*, *beta*, *pinned*.
  - Per item: *Check now*, *Review & update*, *Release notes*, *Settings*, *Skip version*, *Pin*,
    *Rollback*, *Remove*.
  - Toolbar: *Check all now*, *Update all safe* (no password, no major version, no running app;
    asks first).
- **Discover**: *Scan this Mac*, then the results grouped by provider, with checkboxes and
  *Monitor selected*. Duplicates and already-watched items are marked.
- **Queue**: what's running (live log, elapsed time, *Cancel*), what's waiting, and the last few
  finished jobs.
- **Activity**: the audit log (newest first, searchable). Each entry has its details and full
  log.
- **Settings**: check interval, automatic updates (master switch, off), only on AC power, quiet
  hours, code folders for git clones, *Add custom recipe*.
- **Quick view** (menu bar): updates available, items that need you, a countdown to the next
  check, and the outdated items with *Check now*.

## Data

Everything is in the plugin's data folder, `~/Library/Application Support/Toolbelt/data/upkeep/`:

| File | What |
|---|---|
| `items.json` | items you added, their recipes, policies and last results |
| `settings.json` | interval, automatic-update switch, quiet hours, folders |
| `audit.jsonl` | the audit log, one event per line, append-only (rotated at 10 MB) |
| `logs/<job>.log` | full output of each job |
| `discovered.json` | the last scan's results |
| `askpass.sh` | the password-dialog helper (rewritten on start, mode 0700) |

Files are written to a temporary file first and then renamed into place, so a crash never
leaves a half-written file.

## Later

- launchd agent for checks while Toolbelt isn't running; `tb upkeep` command line with `--json`.
- Vulnerability matching from [osv.dev](https://osv.dev) for Homebrew, npm and PyPI packages.
  Known vulnerabilities rank above plain updates.
- Cleanup: `brew cleanup`, old nvm/rustup toolchains, `.old` app bundles, dangling Docker images.
- **Upkeepfile**: export what you watch and how, and import it on a new Mac to install the same
  things.
- macOS notifications for security updates and failures. For now there's the menu bar badge.
- The providers listed under [What it watches](#what-it-watches) as *Later*.

## Known limits of the first version

- **Cancelling stops the command Upkeep started, not its children.** Bun can't start a new
  process group, so a tool that spawned helpers may leave them running.
- **Scheduled checks only run while Toolbelt is running.** Missed checks run when it starts.
- **Sparkle apps and Go are handed over, not installed by Upkeep.** Upkeep opens the app or the
  download page, then checks again 10 minutes later.
- **Only the password-dialog route is built.** Passwords use the `SUDO_ASKPASS` dialog, or
  *Run in Terminal*. The `osascript … with administrator privileges` route is designed but not
  built yet.
- **npm globals belong to one Node.** They're tied to the Node that `npm` on your PATH belongs
  to (with nvm, the default one).
- **macOS, App Store apps, Electron apps, editor extensions, models and Docker images aren't
  covered yet** (see [What it watches](#what-it-watches)).

