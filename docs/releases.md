# Releasing toolbelt-upkeep

The pinned SDK supplies the shared release CLI; no sibling Toolbelt checkout is required.
Use Bun 1.4.4 and authenticated GitHub CLI from a clean, up-to-date main checkout.

```sh
bun run release:plugin --version 1.3.0 --channel stable
bun run release:plugin --version 1.3.0-rc.1 --channel prerelease --check
bun run release:plugin:retry --tag v1.3.0 --pr 12          # before the tag exists
bun run release:plugin:retry --tag v1.3.0 --source <merge-SHA>  # or the exact merge commit
bun run release:plugin:retry --tag v1.3.0                  # once the annotated tag exists
```

Versions are examples. Preparation synchronizes package.json/toolbelt.json and the changelog,
commits the release request and opens a PR. --check validates/builds in temporary staging without
writing to GitHub or tracked files. Missing arguments fail without prompting.

**Merging the validated release PR authorizes CI publication.** Ordinary feature merges do not
publish. CI builds the exact merged source, tests the actual archives on supported native runners,
freezes files/hashes, creates an annotated tag/draft, downloads and verifies every uploaded byte,
then publishes. Stable releases become this repository's Latest; prereleases do not. The engine
also uploads release-record.json. Local build/package commands never publish.

Before tagging, a retry names either the merged release PR (`--pr`) or its exact merge commit
(`--source`), never both; it never guesses from current main. The workflow captures the publisher
CLI from the SDK at the trusted workflow commit before checking out the original source, and
serializes publication per repository. Retry reuses the original candidate; it never overwrites published bytes or moves tags. A failed
build can run again before the candidate is saved. Retained CI candidates expire after 90 days;
if a draft/public release exists but exact files cannot be recovered, stop and use a new version.
See the [shared release reference](https://github.com/tkarakai/toolbelt/blob/main/docs/releases.md)
for permissions, authorization, artifact retention and failure recovery.

The adapter bundles the plugin/migration and packages darwin-arm64 and darwin-x64. Both native runners must pass.
Plugin behavior tests remain here; shared archive/schema/lifecycle validation is supplied by the
SDK development entry point and does not enter the plugin runtime bundle. Keep required host/Bun
ranges and capabilities accurate. Update the exact public SDK URL and lockfile together when
upgrading tooling; publish compatible SDK/host prerequisites before consuming new functionality.
Use isolated profiles, temporary homes and disposable resources for smoke tests.
