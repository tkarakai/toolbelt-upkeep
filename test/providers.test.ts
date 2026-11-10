// Providers' parsers, against the shapes the real tools print.
import { describe, expect, test } from "bun:test";
import { between, changelogSections, githubRepo, htmlToText, tidyMarkdown } from "../lib/notes";
import { caskApps, caskNeedsAuth, formulaCandidates, type BrewInfo } from "../providers/brew";
import { customCandidate, recipeHash } from "../providers/custom";
import { blocker, parseStatus } from "../providers/git";
import { parseCargoList, parseNpmLs, parseUvTools } from "../providers/packages";
import { nodeTarget, nvmDefault, parseRustupCheck } from "../providers/runtimes";
import type { Ctx, Item } from "../lib/types";
import { sparkleProvider, parseAppcast } from "../providers/sparkle";

describe("Homebrew", () => {
	const info = {
		formulae: [
			{ name: "act", full_name: "act", tap: "homebrew/core", desc: "Run GitHub Actions locally", homepage: "https://nektosact.com", versions: { stable: "0.2.97" }, installed: [{ version: "0.2.89", installed_on_request: true }], outdated: true, pinned: false, urls: { stable: { url: "https://github.com/nektos/act/archive/refs/tags/v0.2.97.tar.gz" } } },
			{ name: "brotli", full_name: "brotli", versions: { stable: "1.2.1" }, installed: [{ version: "1.2.0", installed_on_request: false }], outdated: true, pinned: false },
		],
		casks: [
			{ token: "block-goose", full_token: "block-goose", name: ["Goose"], version: "1.57.0", installed: "1.48.0", outdated: true, url: "https://github.com/block/goose/releases/download/v1.57.0/Goose.zip", artifacts: [{ app: ["Goose.app"] }, { zap: [] }] },
			{ token: "vpn", full_token: "vpn", version: "2", installed: "1", outdated: true, artifacts: [{ pkg: ["VPN.pkg"] }] },
		],
	} as unknown as BrewInfo;

	test("formulae you asked for (not dependencies) and casks", () => {
		const c = formulaCandidates(info);
		expect(c.map((x) => x.id)).toEqual(["brew:act", "brew:cask:block-goose", "brew:cask:vpn"]);
		expect(c[0]).toMatchObject({ identity: "tool:act", installed: "0.2.89", data: { type: "formula", repo: "nektos/act" } });
		expect(c[1]).toMatchObject({ kind: "app", identity: "app:Goose.app", data: { app: "/Applications/Goose.app", repo: "block/goose" } });
	});

	test("casks with installers need a password", () => {
		expect(caskApps(info.casks[0])).toEqual(["/Applications/Goose.app"]);
		expect(caskNeedsAuth(info.casks[0])).toBe(false);
		expect(caskNeedsAuth(info.casks[1])).toBe(true);
	});
});

describe("Sparkle appcasts", () => {
	const xml = `<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
		<item><title>Fork 2.70</title><description><![CDATA[<ul><li>Vertical tabs</li><li>Fixed: a crash &amp; more</li></ul>]]></description><pubDate>Fri, 02 Oct 2026 10:00:00 +0000</pubDate>
			<enclosure url="https://cdn.example/Fork-2.70.dmg" sparkle:version="2.70.0"/></item>
		<item><title>Fork 2.71</title><description><![CDATA[<ul><li>Workspaces per window</li></ul>]]></description><pubDate>Fri, 23 Oct 2026 10:50:00 +0000</pubDate>
			<enclosure url="https://cdn.example/Fork-2.71.dmg" sparkle:version="2.71.0" sparkle:shortVersionString="2.71"/></item>
		<item><title>Beta</title><sparkle:channel>beta</sparkle:channel><enclosure sparkle:version="2.72.0"/></item>
	</channel></rss>`;

	test("newest first, versions from elements or the enclosure, notes as text", () => {
		const items = parseAppcast(xml);
		expect(items.map((i) => i.version)).toEqual(["2.72.0", "2.71.0", "2.70.0"]);
		expect(items[1]).toMatchObject({ short: "2.71", date: "2026-10-23", notes: "- Workspaces per window" });
		expect(items[2].notes).toBe("- Vertical tabs\n- Fixed: a crash & more");
		expect(items[0].channel).toBe("beta");
	});
});

describe("runtimes", () => {
	test("rustup check", () => {
		const out = "stable-aarch64-apple-darwin - Update available : 1.93.0 (254b59607 2026-01-19) -> 1.99.1 (58cf8f9c3 2026-10-13)\nnightly-aarch64-apple-darwin - Up to date : 1.100.0-nightly (abc 2026-11-01)\nrustup - Update available : 1.28.2 -> 1.29.3\n";
		expect(parseRustupCheck(out)).toEqual([
			{ name: "stable-aarch64-apple-darwin", installed: "1.93.0", latest: "1.99.1" },
			{ name: "nightly-aarch64-apple-darwin", installed: "1.100.0-nightly", latest: "1.100.0-nightly" },
			{ name: "rustup", installed: "1.28.2", latest: "1.29.3" },
		]);
	});

	test("nvm's default alias", () => {
		const installed = ["v16.20.2", "v20.19.4", "v23.3.0", "v24.21.0"];
		expect(nvmDefault("24\n", installed)).toBe("v24.21.0");
		expect(nvmDefault("v20.19.4", installed)).toBe("v20.19.4");
		expect(nvmDefault("node", installed)).toBe("v24.21.0");
		expect(nvmDefault("18", installed)).toBeUndefined();
	});

	test("Node channels: same major, newest LTS, current", () => {
		const releases = [
			{ version: "v27.1.0", date: "", lts: false as const },
			{ version: "v26.13.0", date: "", lts: "Ultimate" },
			{ version: "v24.22.2", date: "", lts: "Krypton" },
			{ version: "v24.21.0", date: "", lts: "Krypton" },
		];
		expect(nodeTarget(releases, "24.21.0", "major")).toBe("v24.22.2");
		expect(nodeTarget(releases, "24.21.0", "lts")).toBe("v26.13.0");
		expect(nodeTarget(releases, "24.21.0", "current")).toBe("v27.1.0");
	});
});

describe("global packages", () => {
	test("npm, uv tools, cargo", () => {
		expect(parseNpmLs('{"dependencies":{"@openai/codex":{"version":"0.167.0"},"broken":{}}}')).toEqual([{ name: "@openai/codex", version: "0.167.0" }]);
		expect(parseUvTools("warning: Tool `aider-chat` environment not found\nsmolvm v0.0.30\n- smolvm\nspecify-cli v0.0.20\n- specify\n")).toEqual([
			{ name: "smolvm", version: "0.0.30" },
			{ name: "specify-cli", version: "0.0.20" },
		]);
		expect(parseCargoList("paneru v0.3.3:\n    paneru\nlocal v0.1.0 (/Users/x/src/local):\n    local\n")).toEqual([{ name: "paneru", version: "0.3.3" }]);
	});
});

describe("git", () => {
	const status = (ab: string, extra = "") => `# branch.oid 3089371abcdef\n# branch.head main\n# branch.upstream origin/main\n# branch.ab ${ab}\n${extra}`;
	test("status and what blocks a fast-forward", () => {
		expect(parseStatus(status("+0 -2"))).toEqual({ branch: "main", upstream: "origin/main", ahead: 0, behind: 2, dirty: false, head: "3089371" });
		expect(blocker(parseStatus(status("+0 -2")))).toBeUndefined();
		expect(blocker(parseStatus(status("+0 -2", "1 .M N... 100644 100644 100644 a b file.ts\n")))).toContain("uncommitted");
		expect(blocker(parseStatus(status("+1 -2")))).toContain("Diverged");
		expect(blocker(parseStatus("# branch.oid abc\n# branch.head (detached)\n"))).toContain("Detached");
		expect(blocker(parseStatus("# branch.oid abc\n# branch.head topic\n"))).toContain("doesn't track");
	});
});

describe("release notes", () => {
	test("GitHub repos from any URL", () => {
		expect(githubRepo("git+https://github.com/openai/codex.git")).toBe("openai/codex");
		expect(githubRepo("git@github.com:owner/repo.git")).toBe("owner/repo");
		expect(githubRepo("https://github.com/nektos/act/archive/refs/tags/v0.2.97.tar.gz")).toBe("nektos/act");
		expect(githubRepo("https://example.com")).toBeNull();
	});

	test("every version after yours, up to the target, newest first; pre-releases only on request", () => {
		const notes = ["1.0.0", "1.1.0", "1.2.0-beta.1", "1.2.0", "1.3.0"].map((version) => ({ version, body: "" }));
		expect(between(notes, "1.0.0", "1.2.0").map((n) => n.version)).toEqual(["1.2.0", "1.1.0"]);
		expect(between(notes, "1.0.0", "1.2.0", { pre: true }).map((n) => n.version)).toEqual(["1.2.0", "1.2.0-beta.1", "1.1.0"]);
	});

	test("changelog sections", () => {
		const md = "# Changelog\n\n## 2.1.321\n\n- Fixed a thing\n\n## [2.1.320] - 2026-11-01\n\n### Added\n\n- Stuff\n\n## v2.1.319 (2026-10-30)\n- Older\n";
		expect(changelogSections(md)).toEqual([
			{ version: "2.1.321", date: undefined, body: "- Fixed a thing" },
			{ version: "2.1.320", date: "2026-11-01", body: "### Added\n\n- Stuff" },
			{ version: "2.1.319", date: "2026-10-30", body: "- Older" },
		]);
	});

	test("HTML becomes plain Markdown; scripts and tags go", () => {
		expect(htmlToText('<h2>New</h2><ul><li>One <b>bold</b></li><li><a href="https://x.y/1">link</a></li></ul><script>alert(1)</script>')).toBe("### New\n\n- One **bold**\n- [link](https://x.y/1)");
		expect(tidyMarkdown("<details><summary>More</summary>text</details>")).toBe("**More**\ntext");
	});
});

test("custom recipes: editing a command changes the fingerprint", () => {
	const c = customCandidate({ name: "My Tool", version: "mytool -v", latest: "echo 2", update: "mytool up" });
	expect(c.id).toBe("custom:my-tool");
	expect(recipeHash(c.data)).toBe(recipeHash({ ...c.data }));
	expect(recipeHash({ ...c.data, update: "mytool up; rm -rf ~" })).not.toBe(recipeHash(c.data));
});


describe("Sparkle build updates", () => {
	const item: Item = { id: "sparkle:cmux", provider: "sparkle", ref: "/fixture/cmux.app", name: "cmux", kind: "app", identity: "app:cmux.app", addedAt: 0, policy: "notify", state: { outdated: false, failures: 0, nextAt: 0 }, data: { app: "/fixture/cmux.app", feed: "https://fixture/appcast.xml" } };
	const feed = (build: string) => `<rss><item><sparkle:version>${build}</sparkle:version><sparkle:shortVersionString>0.65.2</sparkle:shortVersionString><sparkle:fullReleaseNotesLink>https://fixture/notes</sparkle:fullReleaseNotesLink></item></rss>`;
	const ctx = (build: string): Ctx => ({
		run: async () => ({ code: 0, out: JSON.stringify({ CFBundleShortVersionString: "0.65.2", CFBundleVersion: "111" }), err: "", timedOut: false, cancelled: false }),
		text: async () => feed(build),
		output: async () => "",
		json: async () => { throw new Error("Unexpected JSON request"); },
		log: () => {},
	});

	test("same marketing version exposes the actual build change", async () => {
		expect(await sparkleProvider.check(item, ctx("113"))).toMatchObject({ installed: "0.65.2 (build 111)", latest: "0.65.2 (build 113)", outdated: true });
		for (const build of ["111", "110"]) expect((await sparkleProvider.check(item, ctx(build))).outdated).toBe(false);
	});

	test("release notes include same-version builds and respect the target", async () => {
		const notes = await sparkleProvider.notes!(item, "0.65.2 (build 111)", "0.65.2 (build 113)", ctx("113"));
		expect(notes).toMatchObject([{ version: "0.65.2 (build 113)", url: "https://fixture/notes" }]);
		expect(await sparkleProvider.notes!(item, "0.65.2 (build 113)", "0.65.2 (build 113)", ctx("113"))).toEqual([]);
		expect(await sparkleProvider.notes!(item, "0.65.2 (build 111)", "0.65.2 (build 112)", ctx("113"))).toEqual([]);
	});
});
