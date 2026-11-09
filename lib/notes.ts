// Release notes: from GitHub releases, or a CHANGELOG.md, or an appcast's HTML — always every
// version after the installed one up to the target, newest first. Notes are untrusted text:
// HTML is reduced to Markdown-ish plain text, and the renderer never interprets HTML anyway.
import { compare, clean, isPrerelease } from "./version";
import type { Ctx, Note } from "./types";

/** "owner/repo" from any GitHub URL (git+https, ssh, archive links…). */
export function githubRepo(url: string | undefined): string | null {
	if (!url) return null;
	const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i);
	return m ? `${m[1]}/${m[2]}` : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•" };
export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)));

/** Appcast/release HTML → Markdown-ish text (headings, lists, paragraphs, links). */
export function htmlToText(html: string): string {
	return decode(
		html
			.replace(/<!\[CDATA\[|\]\]>/g, "")
			.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
			.replace(/<h[1-3][^>]*>/gi, "\n### ")
			.replace(/<h[4-6][^>]*>/gi, "\n#### ")
			.replace(/<\/h\d>/gi, "\n")
			.replace(/<li[^>]*>/gi, "\n- ")
			.replace(/<a [^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => `[${text.replace(/<[^>]+>/g, "").trim()}](${href})`)
			.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, "**$2**")
			.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, "_$2_")
			.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|ul|ol|table|tr)>/gi, "\n\n")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** GitHub release bodies may mix in HTML (`<details>`, `<img>`): keep the text. */
export const tidyMarkdown = (md: string) =>
	md
		.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "$1")
		.replace(/<summary>([\s\S]*?)<\/summary>/gi, "**$1**\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(details|summary|p|div|span|sup|sub|picture|source|img|a)[^>]*>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.trim();

/** Keep versions in (from, to], newest first; drop pre-releases unless you're on that channel. */
export function between(notes: Note[], from: string, to: string, opts: { pre?: boolean; max?: number } = {}): Note[] {
	return notes
		.filter((n) => compare(n.version, from) > 0 && compare(n.version, to) <= 0)
		.filter((n) => opts.pre || !isPrerelease(n.version) || compare(n.version, to) === 0)
		.sort((a, b) => compare(b.version, a.version))
		.slice(0, opts.max ?? 60);
}

/**
 * Sections of a CHANGELOG.md, by version heading: "## 1.2.3", "## [1.2.3] - 2026-01-02",
 * "## v1.2.3 (2026-01-02)".
 */
export function changelogSections(md: string): Note[] {
	const out: Note[] = [];
	const lines = md.split("\n");
	let cur: Note | null = null;
	let level = 0;
	for (const line of lines) {
		const h = line.match(/^(#{1,3})\s+\[?v?(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?)\]?(?:\s*[-–(]\s*(\d{4}-\d{2}-\d{2}))?/);
		if (h && (!cur || h[1].length <= level)) {
			if (cur) out.push(cur);
			level = h[1].length;
			cur = { version: h[2], date: h[3], body: "" };
			continue;
		}
		if (cur) cur.body += line + "\n";
	}
	if (cur) out.push(cur);
	return out.map((n) => ({ ...n, body: n.body.trim() }));
}

type Release = { tag_name: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean; published_at?: string; html_url?: string };

const cache = new Map<string, { at: number; value: unknown }>();
const HOUR = 3_600_000;

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < ttl) return hit.value as T;
	const value = await load();
	cache.set(key, { at: Date.now(), value });
	return value;
}

let ghReady: Promise<boolean> | null = null;
/** Is the GitHub CLI installed and signed in? (Higher rate limit for release notes.) */
export function ghAvailable(ctx: Ctx, allowed: boolean): Promise<boolean> {
	if (!allowed) return Promise.resolve(false);
	ghReady ??= ctx.run(["gh", "auth", "status"], { timeoutMs: 10_000 }).then((r) => r.code === 0, () => false);
	return ghReady;
}

export async function github<T>(path: string, ctx: Ctx, useGh: boolean): Promise<T> {
	if (await ghAvailable(ctx, useGh)) return JSON.parse(await ctx.output(["gh", "api", "-H", "Accept: application/vnd.github+json", path], { timeoutMs: 30_000 }));
	return ctx.json<T>(`https://api.github.com/${path.replace(/^\//, "")}`, { headers: { Accept: "application/vnd.github+json" } });
}

/** The newest stable release's version, from GitHub. */
export async function latestRelease(repo: string, ctx: Ctx, useGh: boolean, tagPrefix = ""): Promise<{ version: string; url?: string }> {
	return cached(`latest:${repo}`, HOUR / 4, async () => {
		const r = await github<Release>(`repos/${repo}/releases/latest`, ctx, useGh);
		return { version: clean(r.tag_name.replace(tagPrefix, "")), url: r.html_url };
	});
}

/** Release notes from GitHub releases; falls back to CHANGELOG.md in the repository. */
export async function githubNotes(repo: string, from: string, to: string, ctx: Ctx, opts: { useGh: boolean; tagPrefix?: string; pre?: boolean }): Promise<Note[]> {
	const releases = await cached(`releases:${repo}`, HOUR, async () => {
		const all: Release[] = [];
		for (let page = 1; page <= 3; page++) {
			const batch = await github<Release[]>(`repos/${repo}/releases?per_page=100&page=${page}`, ctx, opts.useGh);
			all.push(...batch);
			// stop once we're past the installed version
			if (batch.length < 100 || batch.some((r) => compare(clean(r.tag_name), from) <= 0)) break;
		}
		return all;
	}).catch(() => [] as Release[]);
	const notes: Note[] = releases
		.filter((r) => !r.draft && (opts.pre || !r.prerelease))
		.map((r) => ({ version: clean(r.tag_name.replace(opts.tagPrefix ?? "", "")), date: r.published_at?.slice(0, 10), body: tidyMarkdown(r.body ?? ""), url: r.html_url }));
	const wanted = between(notes, from, to, { pre: opts.pre });
	if (wanted.length || releases.length) return wanted;
	// No releases at all: try the changelog.
	for (const file of ["CHANGELOG.md", "CHANGES.md", "HISTORY.md"]) {
		const md = await cached(`changelog:${repo}:${file}`, HOUR, () => ctx.text(`https://raw.githubusercontent.com/${repo}/HEAD/${file}`)).catch(() => "");
		if (md) return between(changelogSections(md), from, to, { pre: opts.pre }).map((n) => ({ ...n, url: `https://github.com/${repo}/blob/HEAD/${file}` }));
	}
	return [];
}

/** endoflife.date: when does this version's line stop getting fixes? */
export async function endOfLife(product: string, version: string, ctx: Ctx): Promise<{ at?: string; past: boolean } | undefined> {
	type Cycle = { cycle: string; eol: string | boolean };
	const cycles = await cached(`eol:${product}`, 24 * HOUR, () => ctx.json<Cycle[]>(`https://endoflife.date/api/${product}.json`)).catch(() => null);
	if (!cycles) return undefined;
	const v = clean(version);
	const c = cycles.find((c) => v === c.cycle || v.startsWith(c.cycle + "."));
	if (!c) return undefined;
	if (typeof c.eol === "boolean") return { past: c.eol };
	return { at: c.eol, past: Date.parse(c.eol) <= Date.now() };
}
