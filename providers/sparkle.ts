// Mac apps that update with Sparkle: their Info.plist names an appcast (SUFeedURL). Upkeep
// reads the appcast for versions and notes; the update itself is the app's own (Upkeep opens
// the app), or Homebrew's when the app is also a cask — both show up.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { home, tilde } from "../lib/exec";
import { decode, htmlToText } from "../lib/notes";
import { compare, isPrerelease } from "../lib/version";
import type { Candidate, Ctx, Item, Note, Plan, Provider } from "../lib/types";

export type AppcastItem = { version: string; short?: string; title?: string; date?: string; notes?: string; notesUrl?: string; channel?: string; minSystem?: string; url?: string };

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1]?.trim();
const attr = (xml: string, name: string) => xml.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1];

/** Parse an appcast (RSS + Sparkle's namespace). Versions come from elements or the enclosure. */
export function parseAppcast(xml: string): AppcastItem[] {
	const items: AppcastItem[] = [];
	for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
		const it = m[0];
		const enclosure = it.match(/<enclosure\b[^>]*>/i)?.[0] ?? "";
		const version = tag(it, "sparkle:version") ?? attr(enclosure, "sparkle:version");
		if (!version) continue;
		const notes = tag(it, "description");
		const pub = tag(it, "pubDate");
		items.push({
			version: decode(version),
			short: tag(it, "sparkle:shortVersionString") ?? attr(enclosure, "sparkle:shortVersionString"),
			title: tag(it, "title"),
			date: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub).toISOString().slice(0, 10) : undefined,
			notes: notes ? htmlToText(notes) : undefined,
			notesUrl: tag(it, "sparkle:releaseNotesLink") ?? tag(it, "sparkle:fullReleaseNotesLink"),
			channel: tag(it, "sparkle:channel"),
			minSystem: tag(it, "sparkle:minimumSystemVersion"),
			url: attr(enclosure, "url"),
		});
	}
	return items.sort((a, b) => compare(b.version, a.version));
}

type Plist = { SUFeedURL?: string; CFBundleShortVersionString?: string; CFBundleVersion?: string; CFBundleIdentifier?: string; CFBundleName?: string; CFBundleDisplayName?: string };

const appDirs = () => ["/Applications", join(home, "Applications")].filter(existsSync);

async function readPlist(app: string, ctx: Ctx): Promise<Plist | null> {
	const r = await ctx.run(["/usr/bin/plutil", "-convert", "json", "-o", "-", join(app, "Contents/Info.plist")], { timeoutMs: 10_000 });
	if (r.code !== 0) return null;
	try {
		return JSON.parse(r.out);
	} catch {
		return null;
	}
}

// Preserve Sparkle's ordering identity in the visible version: vendors can publish
// several builds under the same marketing version.
const versionLabel = (short: string | undefined, build: string | undefined) =>
	short && build && short !== build ? `${short} (build ${build})` : short || build || "?";
const display = (p: Plist) => versionLabel(p.CFBundleShortVersionString, p.CFBundleVersion);
const buildOf = (version: string) => version.match(/ \(build (.+)\)$/)?.[1];

/** Channels: Sparkle items without a channel are the default; others ("beta") are opt-in. */
const onChannel = (it: AppcastItem, channel: string | undefined) => !it.channel || it.channel === channel;

async function appcast(item: Item, ctx: Ctx) {
	const items = parseAppcast(await ctx.text(item.data.feed));
	return items.filter((it) => onChannel(it, item.channel) && (item.channel === "beta" || !isPrerelease(it.short ?? it.version)));
}

export const sparkleProvider: Provider = {
	id: "sparkle",
	label: "Sparkle apps",
	available: async () => true,
	async discover(ctx) {
		const out: Candidate[] = [];
		const apps = appDirs().flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".app")).map((f) => join(d, f)));
		for (let i = 0; i < apps.length; i += 12) {
			await Promise.all(
				apps.slice(i, i + 12).map(async (app) => {
					if (existsSync(join(app, "Contents/_MASReceipt"))) return; // App Store apps update there
					const p = await readPlist(app, ctx);
					if (!p?.SUFeedURL || !/^https:\/\//.test(p.SUFeedURL)) return;
					out.push({
						id: `sparkle:${app}`,
						provider: "sparkle",
						ref: app,
						name: p.CFBundleDisplayName || p.CFBundleName || app.split("/").pop()!.replace(/\.app$/, ""),
						kind: "app",
						identity: `app:${app.split("/").pop()}`,
						installed: display(p),
						location: `Sparkle · ${tilde(app)}`,
						data: { app, feed: p.SUFeedURL, ...(p.CFBundleIdentifier && { bundleId: p.CFBundleIdentifier }) },
					});
				}),
			);
		}
		return out;
	},
	async check(item, ctx) {
		const p = await readPlist(item.data.app, ctx);
		if (!p) return { blocked: "The app isn't there any more" };
		const items = await appcast(item, ctx);
		const newest = items[0];
		// Sparkle compares bundle versions (CFBundleVersion); people read the short version.
		const installedBuild = p.CFBundleVersion ?? display(p);
		if (!newest) return { installed: display(p), latest: display(p), outdated: false };
		return { installed: display(p), latest: versionLabel(newest.short, newest.version), outdated: compare(newest.version, installedBuild) > 0 };
	},
	async notes(item, from, to, ctx): Promise<Note[]> {
		const items = await appcast(item, ctx);
		return items
			.filter((it) => {
				const after = buildOf(from) ? compare(it.version, buildOf(from)!) > 0 : compare(it.short ?? it.version, from) > 0;
				const through = buildOf(to) ? compare(it.version, buildOf(to)!) <= 0 : compare(it.short ?? it.version, to) <= 0;
				return after && through;
			})
			.slice(0, 60)
			.map((it) => ({ version: versionLabel(it.short, it.version), date: it.date, body: it.notes ?? (it.notesUrl ? `Release notes: ${it.notesUrl}` : ""), url: it.notesUrl }));
	},
	async plan(item): Promise<Plan> {
		return {
			steps: [{ argv: ["/usr/bin/open", item.data.app], label: `Open ${item.name}` }],
			handoff: `${item.name} updates itself: Upkeep opens it, and it offers the update (or use its “Check for Updates…” menu item). Upkeep checks again afterwards.`,
			warnings: [],
		};
	},
	recipe: (item) => ({ check: `Read the appcast ${item.data.feed}, compare with ${item.data.app}/Contents/Info.plist`, update: `open ${item.data.app} — the app's own updater` }),
	channels: () => [
		{ value: "", label: "Stable" },
		{ value: "beta", label: "Beta (if the app publishes one)" },
	],
};
