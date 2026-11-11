// Runtimes and tools that update themselves or through their own manager: Node (nvm), Bun,
// Deno, uv, Rust (rustup), Go and Claude Code. Each is found at its own install location, so a
// Homebrew copy of the same tool shows up separately (under Homebrew).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { home, tilde } from "../lib/exec";
import { endOfLife, githubNotes, latestRelease } from "../lib/notes";
import { clean, compare, isPrerelease } from "../lib/version";
import type { Candidate, Check, Plan, Provider } from "../lib/types";
import { useGh } from "./shared";

const first = (paths: string[]) => paths.find((p) => existsSync(p));

/** A tool that updates itself and publishes GitHub releases. */
function selfUpdating(o: { id: string; name: string; paths: string[]; versionArgs: string[]; repo: string; tagPrefix?: string; update: string[]; eol?: string; note?: string }): Provider {
	const bin = () => first(o.paths);
	const candidate = (path: string, installed?: string): Candidate => ({
		id: `${o.id}:${path}`,
		provider: o.id,
		ref: path,
		name: o.name,
		kind: "runtime",
		identity: `tool:${o.id}`,
		installed,
		location: tilde(path),
		note: o.note,
		data: { bin: path, repo: o.repo },
	});
	return {
		id: o.id,
		label: o.name,
		available: async () => !!bin(),
		async discover(ctx) {
			const b = bin()!;
			return [candidate(b, clean(await ctx.output([b, ...o.versionArgs], { timeoutMs: 15_000 })))];
		},
		async check(item, ctx): Promise<Check> {
			if (!existsSync(item.data.bin)) return { blocked: "Not installed there any more" };
			const installed = clean(await ctx.output([item.data.bin, ...o.versionArgs], { timeoutMs: 15_000 }));
			const latest = (await latestRelease(o.repo, ctx, useGh(), o.tagPrefix)).version;
			return { installed, latest, eol: o.eol ? await endOfLife(o.eol, installed, ctx) : undefined, homepage: `https://github.com/${o.repo}/releases` };
		},
		notes: (item, from, to, ctx) => githubNotes(item.data.repo, from, to, ctx, { useGh: useGh(), tagPrefix: o.tagPrefix }),
		plan: async (item): Promise<Plan> => ({ steps: [{ argv: [item.data.bin, ...o.update], timeoutMs: 15 * 60_000 }], warnings: [] }),
		recipe: (item) => ({ check: `${tilde(item.data.bin)} ${o.versionArgs.join(" ")}; newest release of github.com/${o.repo}`, update: `${tilde(item.data.bin)} ${o.update.join(" ")}` }),
	};
}

export const bunProvider = selfUpdating({ id: "bun", name: "Bun", paths: [join(home, ".bun/bin/bun")], versionArgs: ["--version"], repo: "oven-sh/bun", tagPrefix: "bun-v", update: ["upgrade"], note: "standalone install" });
export const denoProvider = selfUpdating({ id: "deno", name: "Deno", paths: [join(home, ".deno/bin/deno")], versionArgs: ["--version"], repo: "denoland/deno", update: ["upgrade"], note: "standalone install" });
export const uvProvider = selfUpdating({ id: "uv", name: "uv", paths: [join(home, ".local/bin/uv"), join(home, ".cargo/bin/uv")], versionArgs: ["self", "version"], repo: "astral-sh/uv", update: ["self", "update"], note: "standalone install" });

// ── Claude Code: npm registry for versions, its changelog for notes ──────
export const claudeProvider: Provider = {
	id: "claude",
	label: "Claude Code",
	available: async () => !!first([join(home, ".local/bin/claude"), join(home, ".claude/local/claude")]),
	async discover(ctx) {
		const bin = first([join(home, ".local/bin/claude"), join(home, ".claude/local/claude")])!;
		return [{ id: `claude:${bin}`, provider: "claude", ref: bin, name: "Claude Code", kind: "runtime", identity: "tool:claude", installed: clean(await ctx.output([bin, "--version"], { timeoutMs: 20_000 })), location: tilde(bin), note: "native install", data: { bin } }];
	},
	async check(item, ctx) {
		const installed = clean(await ctx.output([item.data.bin, "--version"], { timeoutMs: 20_000 }));
		const latest = (await ctx.json<{ version: string }>("https://registry.npmjs.org/@anthropic-ai/claude-code/latest")).version;
		return { installed, latest, homepage: "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md" };
	},
	notes: (_item, from, to, ctx) => githubNotes("anthropics/claude-code", from, to, ctx, { useGh: useGh() }),
	plan: async (item) => ({ steps: [{ argv: [item.data.bin, "update"], timeoutMs: 10 * 60_000 }], warnings: [] }),
	recipe: (item) => ({ check: `${tilde(item.data.bin)} --version; npm registry @anthropic-ai/claude-code`, update: `${tilde(item.data.bin)} update` }),
};

// ── Node through nvm ─────────────────────────────────────────────────────
type NodeRelease = { version: string; date: string; lts: string | false };
const nvmDir = () => process.env.NVM_DIR ?? join(home, ".nvm");
const nvmVersions = () => {
	try {
		return readdirSync(join(nvmDir(), "versions/node")).filter((v) => v.startsWith("v")).sort(compare);
	} catch {
		return [];
	}
};
/** The version nvm's `default` alias points at ("24" → the newest installed v24.x). */
export function nvmDefault(alias: string, installed: string[]): string | undefined {
	const a = alias.trim().replace(/^v/, "");
	if (!a || a === "node" || a === "stable") return installed.at(-1);
	return installed.filter((v) => v.replace(/^v/, "") === a || v.replace(/^v/, "").startsWith(a + ".")).at(-1);
}

/** The newest release on a channel: same major, newest LTS, or newest of all. */
export function nodeTarget(releases: NodeRelease[], installed: string, channel: string): string | undefined {
	const major = clean(installed).split(".")[0];
	const pick = channel === "current" ? releases : channel === "lts" ? releases.filter((r) => r.lts) : releases.filter((r) => clean(r.version).split(".")[0] === major);
	return pick.map((r) => r.version).sort(compare).at(-1);
}

const NVM_SCRIPT = 'source "$NVM_DIR/nvm.sh" && nvm install "$1" --reinstall-packages-from="$2" && nvm alias default "$1"';

export const nodeProvider: Provider = {
	id: "nvm",
	label: "Node.js (nvm)",
	available: async () => existsSync(join(nvmDir(), "nvm.sh")),
	async discover() {
		const installed = nvmVersions();
		let alias = "";
		try {
			alias = readFileSync(join(nvmDir(), "alias/default"), "utf8");
		} catch {}
		const current = nvmDefault(alias, installed);
		return [{ id: "nvm:default", provider: "nvm", ref: "default", name: "Node.js", kind: "runtime", identity: "tool:node", installed: current?.replace(/^v/, ""), location: `nvm default → ${current ?? "?"} (${installed.length} installed)`, note: "nvm default", data: { nvm: tilde(nvmDir()) } }];
	},
	async check(item, ctx): Promise<Check> {
		let alias = "";
		try {
			alias = readFileSync(join(nvmDir(), "alias/default"), "utf8");
		} catch {}
		const installed = nvmDefault(alias, nvmVersions());
		if (!installed) return { blocked: "nvm has no default Node version" };
		const releases = await ctx.json<NodeRelease[]>("https://nodejs.org/dist/index.json");
		const channel = item.channel || "major";
		const latest = nodeTarget(releases, installed, channel) ?? installed;
		const newestLts = nodeTarget(releases, installed, "lts");
		const v = installed.replace(/^v/, "");
		return {
			installed: v,
			latest: latest.replace(/^v/, ""),
			channel,
			beyond: newestLts && compare(newestLts, latest) > 0 ? newestLts.replace(/^v/, "") : undefined,
			eol: await endOfLife("nodejs", v.split(".")[0], ctx),
			homepage: "https://nodejs.org/en/blog/release",
		};
	},
	notes: (_item, from, to, ctx) => githubNotes("nodejs/node", from, to, ctx, { useGh: useGh() }),
	async plan(item, target): Promise<Plan> {
		const from = `v${item.state.installed}`;
		return {
			steps: [{ argv: ["/bin/bash", "-c", NVM_SCRIPT, "nvm-update", `v${target}`, from], env: { NVM_DIR: nvmDir() }, label: `nvm install v${target} --reinstall-packages-from=${from} && nvm alias default v${target}`, timeoutMs: 20 * 60_000 }],
			warnings: [`${from} stays installed; Upkeep can switch the default back.`],
		};
	},
	rollback: (_item, to) => ({ steps: [{ argv: ["/bin/bash", "-c", 'source "$NVM_DIR/nvm.sh" && nvm alias default "$1"', "nvm-rollback", `v${to}`], env: { NVM_DIR: nvmDir() }, label: `nvm alias default v${to}` }], warnings: [] }),
	recipe: (item) => ({ check: "nvm's default alias; nodejs.org/dist/index.json; endoflife.date", update: `nvm install <new> --reinstall-packages-from=<current> && nvm alias default <new>  (channel: ${item.channel || "same major"})` }),
	channels: () => [
		{ value: "major", label: "Same major version" },
		{ value: "lts", label: "Newest LTS" },
		{ value: "current", label: "Current (newest)" },
	],
};

// ── Rust through rustup ──────────────────────────────────────────────────
/** `rustup check` lines: "stable-aarch64-apple-darwin - Update available : 1.93.0 (…) -> 1.99.1 (…)". */
export function parseRustupCheck(out: string): { name: string; installed: string; latest: string }[] {
	const res: { name: string; installed: string; latest: string }[] = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^(\S+) - (?:Update available : (\S+).*?-> (\S+)|Up to date : (\S+))/);
		if (m) res.push({ name: m[1], installed: m[2] ?? m[4], latest: m[3] ?? m[4] });
	}
	return res;
}

const rustup = () => first([join(home, ".cargo/bin/rustup")]);

export const rustProvider: Provider = {
	id: "rustup",
	label: "Rust (rustup)",
	serial: true,
	available: async () => !!rustup(),
	async discover(ctx) {
		const rows = parseRustupCheck(await ctx.output([rustup()!, "check"], { timeoutMs: 60_000 }));
		return rows.map((r) => ({
			id: `rustup:${r.name}`,
			provider: "rustup",
			ref: r.name,
			name: r.name === "rustup" ? "rustup" : `Rust ${r.name.split("-")[0]}`,
			kind: "runtime" as const,
			identity: r.name === "rustup" ? "tool:rustup" : `rust:${r.name}`,
			installed: r.installed,
			location: r.name === "rustup" ? tilde(rustup()!) : `rustup · ${r.name}`,
			data: { toolchain: r.name },
		}));
	},
	async check(item, ctx) {
		const row = parseRustupCheck(await ctx.output([rustup()!, "check"], { timeoutMs: 60_000 })).find((r) => r.name === item.data.toolchain);
		if (!row) return { blocked: "Toolchain not installed any more" };
		return { installed: row.installed, latest: row.latest, outdated: row.installed !== row.latest };
	},
	notes: (item, from, to, ctx) => (item.data.toolchain.startsWith("stable") ? githubNotes("rust-lang/rust", from, to, ctx, { useGh: useGh() }) : Promise.resolve([])),
	plan: async (item) => ({ steps: [{ argv: item.data.toolchain === "rustup" ? [rustup()!, "self", "update"] : [rustup()!, "update", item.data.toolchain, "--no-self-update"], timeoutMs: 20 * 60_000 }], warnings: [] }),
	recipe: (item) => ({ check: "rustup check", update: item.data.toolchain === "rustup" ? "rustup self update" : `rustup update ${item.data.toolchain} --no-self-update` }),
};

// ── Go from go.dev's installer ───────────────────────────────────────────
const goBin = () => first(["/usr/local/go/bin/go"]);

export const goProvider: Provider = {
	id: "go",
	label: "Go",
	available: async () => !!goBin(),
	async discover(ctx) {
		return [{ id: "go:/usr/local/go", provider: "go", ref: "/usr/local/go", name: "Go", kind: "runtime", identity: "tool:go", installed: clean(await ctx.output([goBin()!, "version"])), location: "/usr/local/go (go.dev installer)", data: { bin: goBin()! } }];
	},
	async check(item, ctx): Promise<Check> {
		const installed = clean(await ctx.output([item.data.bin, "version"]));
		const releases = await ctx.json<{ version: string; stable: boolean }[]>("https://go.dev/dl/?mode=json");
		const latest = releases.filter((r) => r.stable && !isPrerelease(r.version)).map((r) => clean(r.version)).sort(compare).at(-1);
		return { installed, latest, eol: await endOfLife("go", installed.split(".").slice(0, 2).join("."), ctx), needsAuth: true, homepage: "https://go.dev/doc/devel/release" };
	},
	async plan(_item, target): Promise<Plan> {
		return {
			steps: [{ argv: ["/usr/bin/open", `https://go.dev/dl/#go${target}`], label: "Open go.dev/dl" }],
			handoff: "Go's installer needs your password. Upkeep opens the download page: install the macOS package for your Mac, and Upkeep checks again afterwards.",
			needsAuth: true,
			warnings: [],
		};
	},
	recipe: () => ({ check: "go version; go.dev/dl/?mode=json; endoflife.date", update: "the official package from go.dev/dl (needs your password)" }),
};
