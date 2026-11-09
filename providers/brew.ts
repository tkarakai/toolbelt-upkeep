// Homebrew: formulae you installed (not their dependencies) and casks. One `brew update` and
// one `brew info --installed --json=v2` serve every brew item's check for a few minutes.
import { which } from "../lib/exec";
import { githubNotes, githubRepo } from "../lib/notes";
import { compare } from "../lib/version";
import type { Candidate, Check, Ctx, Plan, Provider } from "../lib/types";
import { useGh } from "./shared";

type Formula = { name: string; full_name: string; desc?: string; homepage?: string; versions: { stable: string }; revision?: number; installed: { version: string; installed_on_request?: boolean }[]; outdated: boolean; pinned: boolean; urls?: { stable?: { url?: string } }; tap?: string };
type Cask = { token: string; full_token: string; name?: string[]; desc?: string; homepage?: string; url?: string; version: string; installed: string | null; outdated: boolean; auto_updates?: boolean | null; artifacts?: Record<string, unknown>[] };
export type BrewInfo = { formulae: Formula[]; casks: Cask[] };

const brew = () => which("brew");

let info: { at: number; value: Promise<BrewInfo> } | null = null;
let updatedAt = 0;

/** `brew update` at most every 10 minutes, then the installed list (cached briefly). */
async function installed(ctx: Ctx, refresh: boolean): Promise<BrewInfo> {
	const b = brew()!;
	if (refresh && Date.now() - updatedAt > 10 * 60_000) {
		ctx.log("brew update");
		const r = await ctx.run([b, "update", "--quiet"], { timeoutMs: 5 * 60_000 });
		if (r.code !== 0) ctx.log(`brew update failed: ${(r.err || r.out).trim().split("\n").at(-1)}`, "warning");
		else updatedAt = Date.now();
		info = null;
	}
	if (!info || Date.now() - info.at > 2 * 60_000) info = { at: Date.now(), value: ctx.output([b, "info", "--installed", "--json=v2"], { timeoutMs: 2 * 60_000 }).then((o) => JSON.parse(o) as BrewInfo) };
	try {
		return await info.value;
	} catch (e) {
		info = null;
		throw e;
	}
}

export const formulaVersion = (f: Formula) => (f.revision ? `${f.versions.stable}_${f.revision}` : f.versions.stable);
const installedFormula = (f: Formula) => f.installed.map((i) => i.version).sort(compare).at(-1);

/** App bundles a cask installs ("Fork.app" → /Applications/Fork.app). */
export function caskApps(c: Cask): string[] {
	const out: string[] = [];
	for (const a of c.artifacts ?? []) {
		const app = (a as { app?: unknown[] }).app;
		if (Array.isArray(app)) for (const x of app) if (typeof x === "string") out.push(x.includes("/") ? x : `/Applications/${x}`);
	}
	return out;
}

/** Casks that run an installer or uninstall scripts usually ask for a password. */
export function caskNeedsAuth(c: Cask): boolean {
	return (c.artifacts ?? []).some((a) => "pkg" in a || "installer" in a || JSON.stringify((a as { uninstall?: unknown }).uninstall ?? "").includes("sudo"));
}

export function formulaCandidates(data: BrewInfo): Candidate[] {
	const out: Candidate[] = [];
	for (const f of data.formulae) {
		const onRequest = f.installed.some((i) => i.installed_on_request);
		if (!onRequest) continue; // dependencies follow their parents
		out.push({
			id: `brew:${f.full_name}`,
			provider: "brew",
			ref: f.full_name,
			name: f.name,
			kind: "package",
			identity: `tool:${f.name}`,
			installed: installedFormula(f),
			location: `brew formula · ${f.tap ?? "homebrew/core"}`,
			description: f.desc,
			data: { type: "formula", name: f.full_name, ...(f.homepage && { homepage: f.homepage }), ...(githubRepo(f.urls?.stable?.url) || githubRepo(f.homepage) ? { repo: (githubRepo(f.urls?.stable?.url) || githubRepo(f.homepage))! } : {}) },
		});
	}
	for (const c of data.casks) {
		const apps = caskApps(c);
		out.push({
			id: `brew:cask:${c.full_token}`,
			provider: "brew",
			ref: c.full_token,
			name: c.name?.[0] ?? c.token,
			kind: "app",
			identity: apps[0] ? `app:${apps[0].split("/").pop()}` : `cask:${c.token}`,
			installed: c.installed ?? undefined,
			location: `brew cask${apps[0] ? ` · ${apps[0]}` : ""}`,
			description: c.desc,
			note: c.auto_updates ? "updates itself too" : undefined,
			data: { type: "cask", name: c.full_token, ...(apps[0] && { app: apps[0] }), ...(c.homepage && { homepage: c.homepage }), ...(githubRepo(c.url) || githubRepo(c.homepage) ? { repo: (githubRepo(c.url) || githubRepo(c.homepage))! } : {}), ...(caskNeedsAuth(c) && { auth: "1" }) },
		});
	}
	return out;
}

export const brewProvider: Provider = {
	id: "brew",
	label: "Homebrew",
	serial: true,
	available: async () => !!brew(),
	discover: async (ctx) => formulaCandidates(await installed(ctx, false)),
	async check(item, ctx): Promise<Check> {
		const data = await installed(ctx, true);
		if (item.data.type === "cask") {
			const c = data.casks.find((x) => x.full_token === item.data.name);
			if (!c) return { blocked: "Not installed any more" };
			// --greedy: casks that update themselves still get a version from Homebrew
			return { installed: c.installed ?? undefined, latest: c.version, outdated: c.version !== "latest" && c.installed !== c.version, homepage: c.homepage };
		}
		const f = data.formulae.find((x) => x.full_name === item.data.name);
		if (!f) return { blocked: "Not installed any more" };
		return { installed: installedFormula(f), latest: formulaVersion(f), outdated: f.outdated, blocked: f.pinned ? "Pinned in Homebrew (brew unpin)" : undefined, homepage: f.homepage };
	},
	async notes(item, from, to, ctx) {
		const repo = item.data.repo;
		if (!repo) return [];
		// Homebrew versions carry revisions ("1.2_1") that upstream doesn't have.
		return githubNotes(repo, from.replace(/_\d+$/, ""), to.replace(/_\d+$/, ""), ctx, { useGh: useGh() });
	},
	async plan(item): Promise<Plan> {
		const b = brew() ?? "brew";
		const cask = item.data.type === "cask";
		const warnings: string[] = [];
		if (cask && item.data.auth) warnings.push("This cask runs an installer, which usually asks for your password.");
		return {
			steps: [{ argv: cask ? [b, "upgrade", "--cask", "--greedy", item.data.name] : [b, "upgrade", item.data.name], timeoutMs: 30 * 60_000 }],
			needsAuth: !!item.data.auth || !!item.state.needsAuth,
			app: cask && item.data.app ? { path: item.data.app, name: item.name } : undefined,
			warnings,
		};
	},
	recipe: (item) => ({
		check: "brew update, then brew info --installed --json=v2",
		update: item.data.type === "cask" ? `brew upgrade --cask --greedy ${item.data.name}` : `brew upgrade ${item.data.name}`,
	}),
};
