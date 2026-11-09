// Git clones with a remote: `git fetch`, then how far behind the upstream branch they are.
// Updating is a fast-forward only, and only when the clone is clean, on a branch that tracks
// an upstream, and has no commits of its own. Anything else needs you.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { home, tilde } from "../lib/exec";
import type { Candidate, Check, Ctx, Item, Note, Plan, Provider } from "../lib/types";
import { settings } from "./shared";

const SKIP = new Set(["node_modules", "vendor", "dist", "build", "target", ".venv", "venv", "Pods", "Library"]);

export const folders = (list: string) =>
	list
		.split(",")
		.map((f) => f.trim().replace(/^~(?=\/|$)/, home))
		.filter((f) => f && existsSync(f));

/** Folders containing a `.git`, up to `depth` levels down; doesn't descend into clones. */
export function findRepos(root: string, depth = 3): string[] {
	const out: string[] = [];
	const walk = (dir: string, d: number) => {
		if (existsSync(join(dir, ".git"))) return void out.push(dir);
		if (d === 0) return;
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.startsWith(".") || SKIP.has(e)) continue;
			const p = join(dir, e);
			try {
				if (statSync(p).isDirectory()) walk(p, d - 1);
			} catch {}
		}
	};
	walk(root, depth);
	return out;
}

export type GitStatus = { branch: string | null; upstream: string | null; ahead: number; behind: number; dirty: boolean; head: string; remoteHead?: string };

/** Parse `git status --porcelain=v2 --branch`. */
export function parseStatus(out: string): Omit<GitStatus, "remoteHead"> {
	let branch: string | null = null;
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	let head = "";
	let dirty = false;
	for (const l of out.split("\n")) {
		if (l.startsWith("# branch.oid ")) head = l.slice(13, 20);
		else if (l.startsWith("# branch.head ")) branch = l.slice(14) === "(detached)" ? null : l.slice(14);
		else if (l.startsWith("# branch.upstream ")) upstream = l.slice(18);
		else if (l.startsWith("# branch.ab ")) {
			const m = l.match(/\+(\d+) -(\d+)/);
			if (m) (ahead = Number(m[1])), (behind = Number(m[2]));
		} else if (l && !l.startsWith("#") && !l.startsWith("?")) dirty = true;
	}
	return { branch, upstream, ahead, behind, dirty, head };
}

/** What stops a fast-forward, in words — or nothing. */
export function blocker(s: Omit<GitStatus, "remoteHead">): string | undefined {
	if (!s.branch) return "Detached HEAD: not on a branch";
	if (!s.upstream) return `Branch ${s.branch} doesn't track a remote branch`;
	if (s.dirty) return "Has uncommitted changes: Upkeep won't touch it";
	if (s.ahead && s.behind) return `Diverged: ${s.ahead} local and ${s.behind} remote commits`;
	return undefined;
}

async function status(repo: string, ctx: Ctx): Promise<GitStatus> {
	const s = parseStatus(await ctx.output(["git", "-C", repo, "status", "--porcelain=v2", "--branch", "--untracked-files=no"], { timeoutMs: 30_000 }));
	let remoteHead: string | undefined;
	if (s.upstream) remoteHead = (await ctx.run(["git", "-C", repo, "rev-parse", "--short=7", "@{u}"], { timeoutMs: 10_000 })).out.trim() || undefined;
	return { ...s, remoteHead };
}

const short = (b: string) => (b.length > 22 ? b.slice(0, 21) + "…" : b);
const describe = (s: GitStatus) => `${short(s.branch ?? "detached")} @ ${s.head}`;

/** The blocker in two or three words, for lists. */
export function shortBlocker(s: Omit<GitStatus, "remoteHead">): string | undefined {
	if (!s.branch) return "detached HEAD";
	if (!s.upstream) return "no upstream";
	if (s.dirty) return "local changes";
	if (s.ahead && s.behind) return "diverged";
	return undefined;
}

export const gitProvider: Provider = {
	id: "git",
	label: "Git clones",
	available: async () => true,
	async discover(ctx) {
		const repos = folders(settings().folders).flatMap((f) => findRepos(f));
		const out: Candidate[] = [];
		for (let i = 0; i < repos.length; i += 8) {
			await Promise.all(
				repos.slice(i, i + 8).map(async (repo) => {
					const remotes = (await ctx.run(["git", "-C", repo, "remote", "-v"], { timeoutMs: 10_000 })).out.trim();
					if (!remotes) return;
					const url = remotes.split("\n")[0].split(/\s+/)[1];
					const s = await status(repo, ctx).catch(() => null);
					out.push({
						id: `git:${repo}`,
						provider: "git",
						ref: repo,
						name: repo.split("/").pop()!,
						kind: "repo",
						identity: `repo:${repo}`,
						installed: s ? describe(s) : undefined,
						location: tilde(repo),
						description: url,
						note: s ? shortBlocker(s) : undefined,
						data: { repo, remote: url },
					});
				}),
			);
		}
		return out;
	},
	async check(item, ctx): Promise<Check> {
		if (!existsSync(join(item.data.repo, ".git"))) return { blocked: "The clone isn't there any more" };
		const fetch = await ctx.run(["git", "-C", item.data.repo, "fetch", "--quiet", "--prune"], { timeoutMs: 2 * 60_000 });
		if (fetch.code !== 0) throw new Error(`git fetch: ${(fetch.err || fetch.out).trim().split("\n").at(-1) || `exit ${fetch.code}`}`);
		const s = await status(item.data.repo, ctx);
		return {
			installed: describe(s),
			latest: s.upstream ? `${short(s.upstream)} @ ${s.remoteHead ?? "?"}${s.behind ? ` (+${s.behind})` : ""}` : undefined,
			outdated: s.behind > 0,
			blocked: s.behind > 0 ? blocker(s) : undefined,
		};
	},
	async notes(item, _from, _to, ctx): Promise<Note[]> {
		const log = await ctx.output(["git", "-C", item.data.repo, "log", "--no-merges", "--date=short", "--format=%h%x09%ad%x09%an%x09%s", "-200", "HEAD..@{u}"], { timeoutMs: 30_000 });
		const lines = log.trim().split("\n").filter(Boolean);
		if (!lines.length) return [];
		const body = lines
			.map((l) => {
				const [sha, date, author, ...subject] = l.split("\t");
				return `- \`${sha}\` ${subject.join("\t").replace(/([*_`[\]])/g, "\\$1")} — ${author}, ${date}`;
			})
			.join("\n");
		return [{ version: `${lines.length} new commit${lines.length === 1 ? "" : "s"}`, body }];
	},
	async plan(item): Promise<Plan> {
		return {
			steps: [{ argv: ["git", "-C", item.data.repo, "merge", "--ff-only", "@{u}"], timeoutMs: 5 * 60_000 }],
			warnings: ["Fast-forward only: stops if the clone has changed since the check."],
		};
	},
	rollback: (item, to) => {
		const sha = to.split(" @ ")[1];
		return sha ? { steps: [{ argv: ["git", "-C", item.data.repo, "reset", "--keep", sha] }], warnings: [`Moves ${to.split(" @ ")[0]} back to ${sha}; local changes are kept.`] } : null;
	},
	recipe: (item) => ({ check: `git -C ${tilde(item.data.repo)} fetch, then status against the upstream branch`, update: `git -C ${tilde(item.data.repo)} merge --ff-only @{u}` }),
};

/** Is a repo's current state safe to fast-forward right now? (checked again right before). */
export async function gitPrecheck(item: Item, ctx: Ctx): Promise<string | undefined> {
	return blocker(await status(item.data.repo, ctx));
}
