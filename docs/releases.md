# Releasing Upkeep

Upkeep publishes ready-to-run GitHub release assets from this repository. There is **no
`bun run release` command**. `bun run build` only replaces local `dist/`; it does not tag,
upload, install or publish anything. CI validates source and packages; publication is manual.
Run the commands below from this repository in one Bash session, stopping on any failure.
Publication requires explicit authorization. The user merges release PRs to `main`.

## Prerequisites and release ownership

- Use a dedicated, clean checkout with no other agent or development process using it. For a
  stable release, use the exact up-to-date `main` commit after the user merges its release PR.
- Use macOS, Bun **1.4.4** (the current CI pin), Git, macOS `tar`/`shasum`, and GitHub CLI `gh`.
  Examples use `gh-axi` for release operations; standard `gh release` supports these same
  flags if that wrapper is unavailable. Metadata checks use standard `gh api`.
- Check `gh auth status --hostname github.com` without printing tokens. The account/token
  needs repository write access and **Contents: read and write**, including tag/release asset
  writes. Git push must also authenticate. CI's read-only token is not a release credential.
- Have a compatible released Toolbelt and standalone Toolbelt Plugin Tester available. This
  repository consumes the public SDK pinned in `package.json` and `bun.lock`; it does not
  publish the SDK, host or tester. If new capabilities require a newer SDK/host, their owner
  must publish those compatible prerequisites first. Follow the host repository's release
  instructions for those products; do not copy their source into Upkeep.
- Current targets are `darwin-arm64` and `darwin-x64`. The build emits both from bundled
  JavaScript, but one machine does not prove both CPU targets work. Arrange a native smoke
  test on each supported architecture before publishing support for it.

## Prepare the version PR

Choose a new, unused semantic version. Set the **same** version in `package.json` and
`toolbelt.json`; move the relevant `CHANGELOG.md` Unreleased notes into a dated section such
as `## 1.2.3 — 2026-11-10`, retaining an Unreleased section for future changes. A prerelease
uses a distinct version such as `1.2.3-rc.1` in both files and tag `v1.2.3-rc.1`.

Commit these changes on a release branch, open a PR, and require CI to pass. Review required
host/Bun ranges, platforms, capabilities and data schema support against the actual code.
Schema changes need a retry-safe migration and failure/recovery coverage; they cannot be
fixed by changing release metadata. The user merges the PR; do not merge it automatically.
A specifically authorized evaluation prerelease may instead use an exact reviewed feature
commit, with a unique plugin version and prerelease tag; it must never become stable latest.

After the merge, start a fresh shell and prepare the stable source:

```bash
set -euo pipefail
# First confirm this checkout is yours and has no unexpected changes.
test -z "$(git status --porcelain)"
git fetch origin --tags
git switch main
git pull --ff-only origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
export UPKEEP_COMMIT="$(git rev-parse HEAD)"
export UPKEEP_VERSION="$(bun -e 'console.log(JSON.parse(await Bun.file("toolbelt.json").text()).version)')"
export UPKEEP_TAG="v${UPKEEP_VERSION}"
export UPKEEP_CHANNEL=stable
export UPKEEP_RELEASE_WORK="$(mktemp -d /tmp/upkeep-release-XXXXXX)"
bun -e 'const p=await Bun.file("package.json").json(),m=await Bun.file("toolbelt.json").json(); if(p.version!==m.version) throw Error("version mismatch"); if(!/^\d+\.\d+\.\d+$/.test(m.version)) throw Error("stable version required");'
test -z "$(git tag --list "$UPKEEP_TAG")"
test -z "$(git ls-remote --tags origin "refs/tags/$UPKEEP_TAG" "refs/tags/$UPKEEP_TAG^{}")"
```

For an authorized prerelease, replace the stable checkout steps with checkout of the reviewed
exact commit, set `UPKEEP_CHANNEL=prerelease`, and replace the stable-version check with a
review of the matching prerelease versions/tag. Do not reuse a version already published
under any other tag. Inspect GitHub's existing releases as well as tags before proceeding.
The build does not enforce clean trees, version uniqueness, tag matching or release channels;
these are publisher checks.

## Validate, build once, and freeze the assets

```bash
test "$(bun --version)" = 1.4.4
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$UPKEEP_COMMIT"
(cd dist && shasum -a 256 --check ./*.sha256)
mkdir "$UPKEEP_RELEASE_WORK/assets"
cp dist/toolbelt-release.json \
  "dist/toolbelt-upkeep-$UPKEEP_VERSION-darwin-arm64.tar.gz" \
  "dist/toolbelt-upkeep-$UPKEEP_VERSION-darwin-arm64.tar.gz.sha256" \
  "dist/toolbelt-upkeep-$UPKEEP_VERSION-darwin-x64.tar.gz" \
  "dist/toolbelt-upkeep-$UPKEEP_VERSION-darwin-x64.tar.gz.sha256" \
  "$UPKEEP_RELEASE_WORK/assets/"
```

`bun test` includes `test/package.test.ts`: it invokes the build, unpacks the current machine's
archive outside this checkout, verifies metadata/hash/size, and executes real child processes
with isolated HOME/data and no ambient `node_modules`. It checks readiness, all five screens
and quick view, scratch updates, logs/restart, migration, busy preparation and inert probes.
This is automated contract testing, not a substitute for native renderer/installed-host checks.
It rebuilds and deletes `dist`; therefore tests run **before** the final build above. Upload
only the frozen files, even if later checks rebuild `dist`.

The final build generates:

| Path | Meaning |
| --- | --- |
| `dist/upkeep/toolbelt.json` | Validated manifest, entry rewritten to `index.js` |
| `dist/upkeep/index.js` | Bun bundle including JavaScript dependencies |
| `dist/upkeep/migrate.js` | Bundled managed-data migration entry |
| `dist/upkeep/NOTICE` | Legal provenance retained in every package |
| `dist/toolbelt-upkeep-<version>-darwin-arm64.tar.gz` | Apple Silicon ready-to-run package |
| `dist/toolbelt-upkeep-<version>-darwin-x64.tar.gz` | Intel ready-to-run package |
| Each archive's `.sha256` | SHA-256 followed by its archive filename |
| `dist/toolbelt-release.json` | Release identity and package metadata |

The **five uploaded assets** are the descriptor, two archives and two checksum sidecars.
`NOTICE` is inside each archive, not a separate upload. Archives use ustar with macOS copyfile
metadata disabled. Do not upload the loose `dist/upkeep/` directory or substitute GitHub's
automatic source-code archives. Toolbelt never installs dependencies or builds publisher source.

The descriptor has `formatVersion: 1`, `id: "upkeep"`, `repo: "tkarakai/toolbelt-upkeep"`,
`version`, the full source `commit`, and `packages` entries with `target`, `asset`, `sha256`
and byte `size`. Hashes and sizes are generated from these exact archive bytes, not constants
or values to edit manually. The source commit must equal the release tag's commit.

## Tag, create a draft, and upload

Write `$UPKEEP_RELEASE_WORK/notes.md` containing the reviewed dated changelog section, supported
targets, minimum compatible host/runtime and any migration/operator requirements. Review it
before creating the tag. Do not put credentials or local paths in release notes.

```bash
test -s "$UPKEEP_RELEASE_WORK/notes.md"
git tag -a "$UPKEEP_TAG" "$UPKEEP_COMMIT" -F "$UPKEEP_RELEASE_WORK/notes.md"
git push origin "refs/tags/$UPKEEP_TAG"
if [ "$UPKEEP_CHANNEL" = prerelease ]; then
  gh-axi release create "$UPKEEP_TAG" --verify-tag --draft --prerelease --latest=false \
    --title "Upkeep $UPKEEP_VERSION" --notes-file "$UPKEEP_RELEASE_WORK/notes.md"
else
  test "$UPKEEP_CHANNEL" = stable
  gh-axi release create "$UPKEEP_TAG" --verify-tag --draft --latest=false \
    --title "Upkeep $UPKEEP_VERSION" --notes-file "$UPKEEP_RELEASE_WORK/notes.md"
fi
gh-axi release upload "$UPKEEP_TAG" \
  "$UPKEEP_RELEASE_WORK/assets/toolbelt-release.json" \
  "$UPKEEP_RELEASE_WORK/assets/toolbelt-upkeep-$UPKEEP_VERSION-darwin-arm64.tar.gz" \
  "$UPKEEP_RELEASE_WORK/assets/toolbelt-upkeep-$UPKEEP_VERSION-darwin-arm64.tar.gz.sha256" \
  "$UPKEEP_RELEASE_WORK/assets/toolbelt-upkeep-$UPKEEP_VERSION-darwin-x64.tar.gz" \
  "$UPKEEP_RELEASE_WORK/assets/toolbelt-upkeep-$UPKEEP_VERSION-darwin-x64.tar.gz.sha256"
```

`--verify-tag` prevents accidental automatic tagging of an unrelated default-branch commit.
Do not force-push tags or use upload `--clobber`.

## Verify the downloaded draft, not only local files

```bash
mkdir "$UPKEEP_RELEASE_WORK/downloaded-draft"
gh-axi release download "$UPKEEP_TAG" --dir "$UPKEEP_RELEASE_WORK/downloaded-draft"
gh api "repos/tkarakai/toolbelt-upkeep/releases/tags/$UPKEEP_TAG" \
  > "$UPKEEP_RELEASE_WORK/github-release.json"
(cd "$UPKEEP_RELEASE_WORK/downloaded-draft" && shasum -a 256 --check ./*.sha256)
test "$(git ls-remote origin "refs/tags/$UPKEEP_TAG^{}" | cut -f1)" = "$UPKEEP_COMMIT"
bun - <<'VERIFY'
import { join } from "node:path";
const work = process.env.UPKEEP_RELEASE_WORK;
const version = process.env.UPKEEP_VERSION;
const assets = join(work, "downloaded-draft");
const d = await Bun.file(join(assets, "toolbelt-release.json")).json();
const r = await Bun.file(join(work, "github-release.json")).json();
const assert = (ok, text) => { if (!ok) throw Error(text); };
assert(d.formatVersion === 1 && d.id === "upkeep" && d.repo === "tkarakai/toolbelt-upkeep", "descriptor identity");
assert(d.version === version && d.commit === process.env.UPKEEP_COMMIT, "descriptor source/version");
assert(r.tag_name === process.env.UPKEEP_TAG && r.draft === true, "expected draft tag");
assert(r.prerelease === (process.env.UPKEEP_CHANNEL === "prerelease"), "release channel");
assert(d.packages.length === 2, "two targets required");
const names = ["toolbelt-release.json"];
for (const target of ["darwin-arm64", "darwin-x64"]) {
  const p = d.packages.find(p => p.target === target);
  assert(p?.asset === `toolbelt-upkeep-${version}-${target}.tar.gz`, "target filename");
  const bytes = new Uint8Array(await Bun.file(join(assets, p.asset)).arrayBuffer());
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  assert(hash === p.sha256 && bytes.byteLength === p.size, "descriptor hash/size");
  assert(await Bun.file(join(assets, `${p.asset}.sha256`)).text() === `${hash}  ${p.asset}\n`, "sidecar");
  names.push(p.asset, `${p.asset}.sha256`);
}
assert(JSON.stringify(r.assets.map(a => a.name).sort()) === JSON.stringify(names.sort()), "exact five assets");
for (const name of names) {
  const local = new Uint8Array(await Bun.file(join(work, "assets", name)).arrayBuffer());
  const remote = new Uint8Array(await Bun.file(join(assets, name)).arrayBuffer());
  assert(Buffer.from(local).equals(Buffer.from(remote)), `frozen bytes: ${name}`);
  const a = r.assets.find(a => a.name === name);
  assert(a.state === "uploaded" && a.size === remote.byteLength, `GitHub size/state: ${name}`);
  if (a.digest) assert(a.digest === `sha256:${new Bun.CryptoHasher("sha256").update(remote).digest("hex")}`, `GitHub digest: ${name}`);
}
console.log("Draft identity, commit, channel, all asset bytes, hashes and sizes verified");
VERIFY
```

Extract only the verified downloaded packages, in fresh temporary directories:

```bash
for UPKEEP_TARGET in darwin-arm64 darwin-x64; do
  UPKEEP_ARCHIVE="$UPKEEP_RELEASE_WORK/downloaded-draft/toolbelt-upkeep-$UPKEEP_VERSION-$UPKEEP_TARGET.tar.gz"
  test "$(tar -tzf "$UPKEEP_ARCHIVE" | LC_ALL=C sort)" = "$(printf '%s\n' NOTICE index.js migrate.js toolbelt.json | LC_ALL=C sort)"
  # Inspect the listing: all four entries must be regular files, with no links or extra paths.
  tar -tvzf "$UPKEEP_ARCHIVE"
  mkdir "$UPKEEP_RELEASE_WORK/$UPKEEP_TARGET"
  tar -xzf "$UPKEEP_ARCHIVE" -C "$UPKEEP_RELEASE_WORK/$UPKEEP_TARGET"
done
```

Review both extracted manifests: id/version/repo, supported target, host/Bun requirements,
capabilities, data schema and migration entry must match the release. Ensure all four files
are nonempty and neither package needs `node_modules` or a sibling source checkout.

**Manual readiness gate:** on each supported CPU, open that exact downloaded archive in the
compatible released standalone Plugin Tester, enter `tkarakai/toolbelt-upkeep` and approve the
publisher. Use an isolated profile, temporary HOME/data and fake resources. Confirm migration
and protocol readiness, all five screens plus quick view, repeated Discover Enter, action keys,
review/notes/log dialogs, themes, narrow layout, zoom and reduced motion. Run a scratch-file
recipe, verify restart persistence and audit, and verify an upgrade/disable refuses while work
is queued/running without cancelling it. Confirm a staged probe performs no checks, updates or
login-shell work. Record tester/host/Bun versions, CPU, release commit and checked asset hashes.
Never update real apps/tools or use working repositories to test a release. The extracted files
and approved archive must execute independently of this source checkout.

## Publish explicitly and check the real host

Only after the draft and manual gates pass, publish the chosen channel:

```bash
if [ "$UPKEEP_CHANNEL" = prerelease ]; then
  gh-axi release edit "$UPKEEP_TAG" --draft=false --prerelease=true --latest=false
else
  test "$UPKEEP_CHANNEL" = stable
  gh-axi release edit "$UPKEEP_TAG" --draft=false --prerelease=false --latest
fi
mkdir "$UPKEEP_RELEASE_WORK/downloaded-published"
gh-axi release download "$UPKEEP_TAG" --dir "$UPKEEP_RELEASE_WORK/downloaded-published"
gh api "repos/tkarakai/toolbelt-upkeep/releases/tags/$UPKEEP_TAG" \
  > "$UPKEEP_RELEASE_WORK/published-release.json"
for UPKEEP_ASSET in "$UPKEEP_RELEASE_WORK/downloaded-draft/"*; do
  cmp "$UPKEEP_ASSET" "$UPKEEP_RELEASE_WORK/downloaded-published/$(basename "$UPKEEP_ASSET")"
done
(cd "$UPKEEP_RELEASE_WORK/downloaded-published" && shasum -a 256 --check ./*.sha256)
```

Inspect published metadata: `draft` must be false, `prerelease` must match the channel, and the
five names/sizes/digests must remain unchanged. For stable, `gh api
repos/tkarakai/toolbelt-upkeep/releases/latest` must resolve to this tag; prereleases must not
replace stable latest. Install **from `tkarakai/toolbelt-upkeep` in the real compatible host's
plugin manager**, using an isolated configuration/data directory. Select the exact prerelease
tag when appropriate; normal stable discovery uses latest. Approve the publisher, verify the
installed version/readiness and screens, preserved data on upgrade, and busy-update deferral
using disposable fixtures. This checks GitHub resolution and actual managed installation, not
source-copy installation. Keep evidence and frozen assets until acceptance is complete.

## Failure and recovery

| Failure point | Required response |
| --- | --- |
| Before tagging | Fix source through a PR, rerun checks and final build from its clean merged commit. Discard unverified local outputs. |
| Tag pushed, no release | If the tag points to the correct commit, resume with the original frozen assets. If wrong, stop and choose a fresh version/tag through a correction PR; never move or force the tag. |
| Draft creation/upload interrupted | Inspect the existing draft and download its assets. Verify against frozen bytes; upload only missing filenames. Do not rerun create blindly or clobber existing assets. A mismatch blocks publication. |
| Frozen bytes lost | Recover the exact verified bytes from the draft/cache and reverify. Rebuilding can change archive bytes; never present regenerated bytes as the same verified version. If provenance cannot be established, prepare a new version/tag. |
| Version/tag/commit or compatibility mismatch | Stop. Correct source/version/manifest and repeat validation with a new version when a tag or bytes already exist. Do not hand-edit descriptor hashes or disguise incompatibility in notes. |
| Migration/probe/readiness failure | Leave the release unpublished; fix and test retry/recovery. Do not bypass schema checks, execute source in the host, or cancel real work to force an upgrade. |
| Published defect | Never silently replace assets, reuse that plugin version, move its tag or delete/recreate the release. Notify affected users and publish a corrected, newly versioned release after validation. Any withdrawal/latest change needs an explicit operator decision and does not undo installed copies. |

Published package bytes are immutable **across all tags for a plugin version**. A prerelease
cannot be converted into different stable bytes under the same version. A normal stable
release gets its own matching package/manifest version and tag. Toolbelt's managed-data
recovery restores compatible code/data snapshots; it does not roll back software Upkeep has
updated. Busy provider work must finish or be explicitly cancelled by the user, never by the
publisher or an upgrade retry.
