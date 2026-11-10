// Upkeep's screens, built from the engine's state. Dialogs belong to the screen they were
// opened on.
import type { Action, Dialog, LogLine, Node, Row, Tone } from "@toolbelt/sdk";
import { relative } from "@toolbelt/sdk";
import { bulkUpdatable, hasUpdate, stepOf, type Engine, type Job } from "./lib/engine";
import { show, tilde } from "./lib/exec";
import type { AuditEntry } from "./lib/store";
import { KIND_LABEL, POLICY_LABEL, type Candidate, type Item, type Kind, type Note, type Plan } from "./lib/types";
import { isPrerelease } from "./lib/version";
import { PROVIDERS, provider } from "./providers";

export type Review = { itemId: string; target?: string; loading: boolean; plan?: Plan; notes?: Note[]; error?: string; notesError?: string };
export type RecipeDraft = { name: string; version: string; latest: string; update: string; repo: string };
export type UI = {
	query: Record<string, string>;
	/** The open dialog and the screen it's on. */
	dialog: null | { surface: string } & ({ kind: "review"; review: Review } | { kind: "settings"; itemId: string } | { kind: "log"; jobId: string } | { kind: "history"; itemId: string } | { kind: "recipe"; draft: RecipeDraft });
};

export const ui: UI = { query: {}, dialog: null };

const KIND_ORDER: Kind[] = ["app", "runtime", "package", "repo", "custom"];
const day = (at: number) => {
	const d = new Date(at);
	const today = new Date();
	const y = new Date(Date.now() - 86_400_000);
	if (d.toDateString() === today.toDateString()) return "Today";
	if (d.toDateString() === y.toDateString()) return "Yesterday";
	return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};
const when = (at?: number) => (at ? `${new Date(at).toLocaleString()} (${relative(at)})` : "—");
const matches = (q: string | undefined, ...parts: (string | undefined)[]) => !q || parts.join(" ").toLowerCase().includes(q.toLowerCase());
const BY: Record<string, string> = { you: "You", schedule: "Schedule", auto: "Automatic" };

function jobFor(engine: Engine, itemId: string) {
	return engine.jobs.find((j) => j.itemId === itemId && (j.state === "running" || j.state === "queued"));
}

function statusOf(engine: Engine, it: Item): { tone: Tone; text: string } {
	const job = jobFor(engine, it.id);
	if (job) return { tone: "info", text: job.state === "running" ? `${job.type === "check" ? "Checking" : job.type === "update" ? "Updating" : "Working"}…` : "Waiting…" };
	const s = it.state;
	if (s.error) return { tone: "danger", text: `Check failed (${s.failures}×)` };
	if (s.eol?.past) return { tone: "danger", text: "End of life" };
	if (hasUpdate(it)) return { tone: "warning", text: s.blocked || s.needsAuth ? "Needs you" : "Update available" };
	if (s.blocked) return { tone: "warning", text: s.blocked };
	if (!s.checkedAt) return { tone: "muted", text: "Not checked yet" };
	return { tone: "success", text: "Up to date" };
}

function chips(engine: Engine, it: Item): string[] {
	const s = it.state;
	const out: string[] = [];
	const step = stepOf(it);
	if (hasUpdate(it) && step === "major") out.push("major");
	if (s.latest && it.provider !== "git" && isPrerelease(s.latest)) out.push("pre-release");
	if (s.eol?.past) out.push("EOL");
	else if (s.eol?.at && Date.parse(s.eol.at) - Date.now() < 180 * 86_400_000) out.push(`EOL ${s.eol.at}`);
	if (s.beyond) out.push(`newer: ${s.beyond}`);
	if (s.needsAuth && hasUpdate(it)) out.push("password");
	if (it.pinned) out.push("pinned");
	if (it.skip && s.latest === it.skip) out.push("skipped");
	for (const sib of engine.siblings(it)) out.push(`also: ${provider(sib.provider)?.label ?? sib.provider}`);
	return out;
}

// ── Monitored ────────────────────────────────────────────────────────────
export function monitored(engine: Engine, surface: string): Node {
	const q = ui.query[surface];
	const items = engine.items.filter((it) => matches(q, it.name, it.location, it.provider, it.state.installed));
	const updates = engine.updates();
	const safe = updates.filter(bulkUpdatable);
	const rows: Row[] = [...items]
		.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || Number(hasUpdate(b)) - Number(hasUpdate(a)) || a.name.localeCompare(b.name))
		.map((it) => {
			const st = statusOf(engine, it);
			const s = it.state;
			const p = provider(it.provider);
			const recipe = p?.recipe(it);
			const job = jobFor(engine, it.id);
			const canRollback = !!(s.previous && p?.rollback?.(it, s.previous));
			return {
				id: it.id,
				group: KIND_LABEL[it.kind],
				cells: {
					name: { text: it.name, sub: it.location ?? p?.label, dot: st.tone },
					installed: { text: s.installed ?? "—", mono: true },
					latest: { text: s.latest ?? "—", mono: true, tone: hasUpdate(it) ? "warning" : s.outdated ? "muted" : "default", sub: st.text !== "Up to date" ? st.text : undefined, chips: chips(engine, it) },
					checked: s.checkedAt ? { text: "", at: s.checkedAt, tone: "muted" } : { text: "never", tone: "muted" },
					next: job ? { text: job.state === "running" ? "now" : "queued", tone: "info" } : { text: "", at: s.nextAt },
					policy: { text: POLICY_LABEL[it.policy], tone: it.policy === "notify" ? "muted" : "default" },
				},
				actions: ["check", ...(s.outdated ? ["review"] : ["notes"]), "settings", "history", ...(s.outdated && !it.skip ? ["skip"] : []), it.pinned ? "unpin" : "pin", ...(canRollback ? ["rollback"] : []), "remove"],
				details: [
					{ label: "Status", value: st.text },
					{ label: "Installed → newest", value: `${s.installed ?? "?"} → ${s.latest ?? "?"}`, mono: true },
					...(s.blocked ? [{ label: "Needs you", value: s.blocked }] : []),
					...(s.error ? [{ label: "Last error", value: `${s.error} (${s.failures} in a row; retrying ${relative(s.nextAt)})` }] : []),
					...(s.eol ? [{ label: "End of life", value: s.eol.past ? `Yes${s.eol.at ? `, since ${s.eol.at}` : ""}` : (s.eol.at ?? "—") }] : []),
					...(s.beyond ? [{ label: "Outside your channel", value: `${s.beyond} is newer (change the channel in Settings)` }] : []),
					{ label: "Last check", value: `${when(s.checkedAt)}${s.checkMs ? ` · took ${(s.checkMs / 1000).toFixed(1)} s` : ""}` },
					{ label: "Next check", value: when(s.nextAt) },
					{ label: "Policy", value: `${POLICY_LABEL[it.policy]}${it.policy !== "notify" && !engine.settings.autoUpdates ? " (automatic updates are off in Settings)" : ""}` },
					...(it.channel ? [{ label: "Channel", value: it.channel }] : []),
					{ label: "Provider", value: p?.label ?? it.provider },
					...(it.location ? [{ label: "Where", value: it.location, mono: true }] : []),
					...(it.description ? [{ label: "About", value: it.description }] : []),
					{ label: "Checks with", value: recipe?.check ?? "—", mono: true },
					{ label: "Updates with", value: recipe?.update ?? "—", mono: true },
					...(engine.siblings(it).length ? [{ label: "Also installed via", value: engine.siblings(it).map((x) => `${provider(x.provider)?.label}: ${x.location ?? x.ref}`).join("\n") }] : []),
					...(s.previous ? [{ label: "Before the last update", value: s.previous, mono: true }] : []),
					...(s.updatedAt ? [{ label: "Last updated", value: when(s.updatedAt) }] : []),
					...(s.homepage ? [{ label: "Release notes", value: s.homepage, mono: true }] : []),
					{ label: "Watching since", value: when(it.addedAt) },
				],
			};
		});
	const bits = [`${engine.items.length} watched`, updates.length ? `${updates.length} update${updates.length > 1 ? "s" : ""}` : "all up to date", engine.needsYou().length ? `${engine.needsYou().length} need${engine.needsYou().length > 1 ? "" : "s"} you` : ""].filter(Boolean);
	return page(surface, {
		type: "page",
		search: { placeholder: "Filter by name, folder, provider…" },
		summary: engine.items.length ? bits.join(" · ") : "",
		actions: [
			{ id: "check-all", label: "Check all now", icon: "refresh-cw", disabled: !engine.items.length },
			{ id: "update-safe", label: safe.length ? `Update ${safe.length} safe` : "Update safe", icon: "download", primary: safe.length > 0, disabled: !safe.length, confirm: `Update ${safe.map((i) => i.name).join(", ")}? Only non-app items that need no password and aren't a major version. Review apps individually before updating.` },
		],
		children: [
			{
				type: "table",
				id: "items",
				columns: [
					{ key: "name", title: "Name", grow: true },
					{ key: "installed", title: "Installed", mono: true },
					{ key: "latest", title: "Newest" },
					{ key: "checked", title: "Checked", optional: true },
					{ key: "next", title: "Next check", align: "right" },
					{ key: "policy", title: "Policy", optional: true },
				],
				rows,
				actions: [
					{ id: "check", key: "c", label: "Check now", icon: "refresh-cw", inline: true },
					{ id: "review", key: "u", label: "Review & update", icon: "download", inline: true },
					{ id: "notes", key: "n", label: "Release notes", icon: "file-text" },
					{ id: "settings", key: "e", label: "Settings…", icon: "sliders-horizontal" },
					{ id: "history", key: "h", label: "History", icon: "clock" },
					{ id: "skip", key: "s", label: "Skip this version", icon: "skip-forward" },
					{ id: "pin", key: "p", label: "Pin at this version", icon: "pin" },
					{ id: "unpin", key: "p", label: "Unpin", icon: "pin-off" },
					{ id: "rollback", key: "r", label: "Roll back", icon: "undo-2", confirm: "Go back to the version before the last update?" },
					{ id: "remove", key: "x", label: "Stop watching", icon: "trash", tone: "destructive", confirm: "Stop watching this? Nothing is uninstalled." },
				],
				bulkActions: [
					{ id: "check-many", label: "Check now", icon: "refresh-cw" },
					{ id: "remove-many", label: "Stop watching", icon: "trash", tone: "destructive", confirm: "Stop watching the selected items? Nothing is uninstalled." },
				],
				empty: q ? { title: "Nothing matches", icon: "search-x" } : { title: "Nothing watched yet", description: "Open Discover and scan this Mac, then choose what Upkeep should keep up to date. Nothing is checked or changed until you do.", icon: "radar" },
			},
		],
	});
}

// ── Discover ─────────────────────────────────────────────────────────────
export function discover(engine: Engine, surface: string): Node {
	const q = ui.query[surface];
	const d = engine.discovered;
	const scanning = engine.jobs.find((j) => j.type === "scan" && (j.state === "running" || j.state === "queued"));
	const byIdentity = new Map<string, Candidate[]>();
	for (const c of d?.candidates ?? []) byIdentity.set(c.identity, [...(byIdentity.get(c.identity) ?? []), c]);
	const label = (c: Candidate) => provider(c.provider)?.label ?? c.provider;
	const order = (c: Candidate) => PROVIDERS.findIndex((p) => p.id === c.provider);
	const rows: Row[] = (d?.candidates ?? [])
		.filter((c) => matches(q, c.name, c.location, c.description, label(c)))
		.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
		.map((c) => {
			const watched = !!engine.item(c.id);
			const others = (byIdentity.get(c.identity) ?? []).filter((x) => x.id !== c.id);
			return {
				id: c.id,
				group: label(c),
				cells: {
					name: { text: c.name, sub: c.location, dot: watched ? "success" : others.length ? "warning" : "muted" },
					version: { text: c.installed ?? "—", mono: true },
					notes: { text: watched ? "Watching" : (c.note ?? ""), tone: watched ? "success" : "muted", chips: others.map((o) => `also: ${label(o)}`) },
				},
				actions: watched ? ["remove"] : ["monitor"],
				details: [
					{ label: "Where", value: c.location ?? "—", mono: true },
					...(c.description ? [{ label: "About", value: c.description }] : []),
					{ label: "Version", value: c.installed ?? "—", mono: true },
					...(others.length ? [{ label: "Also installed via", value: others.map((o) => `${label(o)}: ${o.location ?? o.ref}`).join("\n") }] : []),
					...(c.note ? [{ label: "Note", value: c.note }] : []),
				],
			};
		});
	const errors = Object.entries(d?.errors ?? {});
	const dupes = [...byIdentity.values()].filter((l) => l.length > 1).length;
	const summary = scanning ? "Scanning this Mac…" : d ? [`${d.candidates.length} found ${relative(d.at)}`, dupes ? `${dupes} installed more than once` : "", errors.length ? `${errors.length} provider${errors.length > 1 ? "s" : ""} failed (see Activity)` : ""].filter(Boolean).join(" · ") : "";
	return page(surface, {
		type: "page",
		search: { placeholder: "Filter by name, folder, provider…" },
		summary,
		actions: [{ id: "scan", label: d ? "Scan again" : "Scan this Mac", icon: "radar", primary: !d, disabled: !!scanning }],
		children: [
			{
				type: "table",
				id: "candidates",
				columns: [
					{ key: "name", title: "Name", grow: true },
					{ key: "version", title: "Version", mono: true },
					{ key: "notes", title: "" },
				],
				rows,
				actions: [
					{ id: "monitor", key: "w", label: "Watch", icon: "eye", inline: true },
					{ id: "remove", key: "x", label: "Stop watching", icon: "eye-off", inline: true },
				],
				bulkActions: [{ id: "monitor-many", label: "Watch selected", icon: "eye", primary: true }],
				empty: scanning
					? { title: "Scanning…", description: "Looking at Homebrew, apps, runtimes, global packages and git clones.", icon: "radar" }
					: q && d
						? { title: "Nothing matches", icon: "search-x" }
						: { title: "Find what can be kept up to date", description: "Scanning only reads: it lists Homebrew packages, apps that update with Sparkle, runtimes, global packages and git clones. You choose what to watch.", icon: "radar" },
			},
		],
	});
}

// ── Queue ────────────────────────────────────────────────────────────────
const jobDot = (j: Job): Tone => (j.state === "running" || j.state === "queued" ? "info" : (j.tone ?? (j.state === "failed" ? "danger" : j.state === "cancelled" ? "muted" : "success")));

export function queue(engine: Engine, surface: string): Node {
	const running = engine.jobs.filter((j) => j.state === "running");
	const waiting = engine.jobs.filter((j) => j.state === "queued");
	const done = engine.jobs.filter((j) => j.state !== "running" && j.state !== "queued").reverse().slice(0, 25);
	const children: Node[] = [];
	if (!running.length && !waiting.length) children.push({ type: "empty", title: "Nothing running", description: `Checks and updates show up here while they run. Next check ${engine.nextCheck() ? relative(engine.nextCheck()!) : "—"}.`, icon: "list-checks" });
	for (const j of running)
		children.push({
			type: "card",
			id: j.id,
			title: j.title,
			description: `${BY[j.by]} · ${j.type}`,
			tone: "info",
			actions: [{ id: "cancel", label: "Cancel", icon: "square", tone: "destructive" }],
			children: [
				{ type: "progress", label: [...j.lines].reverse().find((l) => l.tone !== "muted")?.text ?? "Starting…", at: j.startedAt },
				{ type: "log", id: `log-${j.id}`, lines: j.lines.slice(-300) as LogLine[], follow: true },
			],
		});
	if (waiting.length)
		children.push({
			type: "card",
			title: `Waiting (${waiting.length})`,
			description: "One job at a time per provider, three at once in all.",
			children: [{ type: "list", id: "waiting", items: waiting.map((j) => ({ id: j.id, title: j.title, subtitle: BY[j.by], dot: "muted" as Tone, metaAt: j.queuedAt, actions: [{ id: "cancel", label: "Cancel", icon: "x" }] })) }],
		});
	if (done.length)
		children.push({
			type: "card",
			title: "Finished",
			children: [{ type: "list", id: "done", items: done.map((j) => ({ id: j.id, title: j.title, subtitle: j.result ?? j.state, dot: jobDot(j), metaAt: j.endedAt, actions: [{ id: "log", label: "Show log", icon: "scroll-text" }] })) }],
		});
	return page(surface, { type: "page", summary: `${running.length} running · ${waiting.length} waiting`, children });
}

// ── Activity ─────────────────────────────────────────────────────────────
const EVENT: Record<AuditEntry["event"], string> = { added: "Watching", removed: "Removed", changed: "Changed", scan: "Scan", check: "Check", update: "Update", rollback: "Rollback", skipped: "Skipped", cancelled: "Cancelled", started: "Started" };

export function activity(engine: Engine, surface: string): Node {
	const q = ui.query[surface];
	const entries = engine.audit.filter((e) => matches(q, e.name, e.text, e.event, e.by)).slice(-1000).reverse();
	// Stable ids (new entries keep the selection where it was); the job id comes last.
	const rows: Row[] = entries.map((e) => ({
		id: `${e.at}|${e.event}|${e.item ?? ""}|${e.job ?? ""}`,
		group: day(e.at),
		cells: {
			what: { text: e.name ? `${e.name}: ${EVENT[e.event]}` : EVENT[e.event], sub: e.text, dot: e.tone },
			by: { text: e.by ? BY[e.by] : "", tone: "muted" },
			at: { text: "", at: e.at, tone: "muted" },
		},
		actions: e.job ? ["log"] : [],
		details: [
			{ label: "When", value: new Date(e.at).toLocaleString() },
			{ label: "What", value: e.text },
			...(e.by ? [{ label: "Started by", value: BY[e.by] }] : []),
			...(e.name ? [{ label: "Item", value: e.name }] : []),
			...Object.entries(e.detail ?? {}).map(([label, value]) => ({ label, value, mono: true })),
			...(e.job ? [{ label: "Log", value: tilde(engine.store.logFile(e.job)), mono: true }] : []),
		],
	}));
	return page(surface, {
		type: "page",
		search: { placeholder: "Filter the activity…" },
		summary: `${engine.audit.length} events · ${tilde(engine.store.dir)}/audit.jsonl`,
		children: [
			{
				type: "table",
				id: "audit",
				columns: [
					{ key: "what", title: "What happened", grow: true },
					{ key: "by", title: "By", optional: true },
					{ key: "at", title: "When", align: "right" },
				],
				rows,
				actions: [{ id: "log", key: "l", label: "Show log", icon: "scroll-text", inline: true }],
				empty: { title: q ? "Nothing matches" : "No activity yet", description: "Every scan, check, update and setting change is recorded here.", icon: "clock" },
			},
		],
	});
}

// ── Settings ─────────────────────────────────────────────────────────────
export function settingsScreen(engine: Engine, surface: string): Node {
	const s = engine.settings;
	const custom = engine.items.filter((i) => i.provider === "custom");
	return page(surface, {
		type: "page",
		actions: [{ id: "add-recipe", label: "Add a custom recipe", icon: "plus" }],
		children: [
			{
				type: "form",
				id: "settings",
				title: "Checking",
				description: "Upkeep only checks what you chose to watch.",
				fields: [
					{ type: "select", id: "intervalHours", label: "Check every", value: String(s.intervalHours), options: ["1", "3", "6", "12", "24", "168"].map((v) => ({ value: v, label: v === "168" ? "week" : `${v} hour${v === "1" ? "" : "s"}` })), description: "Items can have their own interval. Checks missed while the Mac slept run when it wakes." },
					{ type: "switch", id: "useGh", label: "Use the GitHub CLI for release notes", value: s.useGh, description: "When `gh` is signed in: a higher rate limit for GitHub releases." },
					{ type: "text", id: "folders", label: "Where your git clones are", value: s.folders, placeholder: "~/dev, ~/code", description: "Comma-separated; searched three levels deep when you scan." },
				],
			},
			{
				type: "form",
				id: "settings",
				title: "Automatic updates",
				description: "Off until you turn them on. Each item also needs a policy other than “Notify only”. Updates that need a password, quit a running app, update in their own app, or are your own commands never run automatically.",
				fields: [
					{ type: "switch", id: "autoUpdates", label: "Allow automatic updates", value: s.autoUpdates },
					{ type: "switch", id: "acOnly", label: "Only on AC power", value: s.acOnly },
					{ type: "select", id: "window", label: "When", value: s.window, options: [{ value: "any", label: "Any time" }, { value: "night", label: "At night (1:00–6:00)" }] },
				],
			},
			{
				type: "card",
				title: "Custom recipes",
				description: "Your own commands for things no provider covers. They run in a shell, only after you've reviewed them, and never automatically.",
				children: custom.length ? [{ type: "list", id: "recipes", items: custom.map((c) => ({ id: c.id, title: c.name, subtitle: c.data.update, actions: [{ id: "remove", label: "Remove", icon: "trash", confirm: "Remove this recipe?" }] })) }] : [{ type: "text", text: "None yet.", tone: "muted" }],
			},
			{ type: "text", text: `Data, audit log and job logs: ${tilde(engine.store.dir)}`, tone: "muted" },
		],
	});
}

// ── quick view ───────────────────────────────────────────────────────────
export function quick(engine: Engine): Node {
	if (!engine.items.length) return { type: "empty", title: "Nothing watched yet", description: "Open Upkeep › Discover to choose what to keep up to date.", icon: "radar" };
	const updates = engine.updates();
	const next = engine.nextCheck();
	const running = engine.jobs.filter((j) => j.state === "running");
	return {
		type: "stack",
		gap: 3,
		children: [
			{
				type: "stats",
				items: [
					{ label: "Updates", value: String(updates.length), tone: updates.length ? "warning" : "success" },
					{ label: "Need you", value: String(engine.needsYou().length) },
					running.length ? { label: "Now", value: `${running.length} running` } : { label: "Next check", value: "—", at: next },
				],
			},
			{
				type: "list",
				id: "updates",
				items: updates.slice(0, 8).map((it) => ({ id: it.id, title: it.name, subtitle: `${it.state.installed} → ${it.state.latest}${it.state.blocked || it.state.needsAuth ? " · needs you" : ""}`, dot: (it.state.eol?.past ? "danger" : "warning") as Tone, metaAt: it.state.checkedAt, actions: [{ id: "check", label: "Check now", icon: "refresh-cw" }] })),
				empty: { title: "Everything is up to date", icon: "circle-check" },
			},
		],
	};
}

// ── dialogs ──────────────────────────────────────────────────────────────
function page(surface: string, node: Extract<Node, { type: "page" }>): Node {
	const d = ui.dialog;
	if (d && d.surface === surface) node.dialog = dialogNode(currentEngine!, d);
	return node;
}

let currentEngine: Engine | null = null;
export const bindEngine = (e: Engine) => void (currentEngine = e);

function dialogNode(engine: Engine, d: NonNullable<UI["dialog"]>): Dialog | undefined {
	switch (d.kind) {
		case "review":
			return reviewDialog(engine, d.review);
		case "settings": {
			const it = engine.item(d.itemId);
			if (!it) return undefined;
			const channels = provider(it.provider)?.channels?.(it);
			const auto = it.provider === "custom" || it.provider === "sparkle" || it.provider === "go";
			return {
				id: "settings",
				title: `${it.name}: settings`,
				description: "Changes apply right away and are recorded in Activity.",
				children: [
					{
						type: "form",
						id: "item",
						fields: [
							auto
								? { type: "select", id: "policy", label: "When there's an update", value: "notify", options: [{ value: "notify", label: POLICY_LABEL.notify }], description: "This kind is always updated by you." }
								: { type: "select", id: "policy", label: "When there's an update", value: it.policy, options: (Object.keys(POLICY_LABEL) as (keyof typeof POLICY_LABEL)[]).map((p) => ({ value: p, label: POLICY_LABEL[p] })), description: engine.settings.autoUpdates ? "Automatic updates are on in Settings." : "Automatic updates are off in Settings, so this only takes effect once you turn them on." },
							...(channels ? [{ type: "select" as const, id: "channel", label: "Channel", value: it.channel ?? channels[0].value, options: channels.map((c) => ({ ...c, value: c.value || "stable" })) }] : []),
							{ type: "select", id: "interval", label: "Check every", value: String(it.intervalHours ?? "default"), options: [{ value: "default", label: `Default (${engine.settings.intervalHours} h)` }, ...["1", "3", "6", "12", "24", "168"].map((v) => ({ value: v, label: v === "168" ? "week" : `${v} h` }))] },
							{ type: "switch", id: "pinned", label: "Pinned", value: !!it.pinned, description: "Keep this version: updates are shown but not counted or offered." },
						],
					},
				],
				actions: [{ id: "dialog-done", label: "Done", primary: true }],
			};
		}
		case "log": {
			const job = engine.jobs.find((j) => j.id === d.jobId);
			const lines: LogLine[] = job ? job.lines : engine.store.readLog(d.jobId).map((l) => ({ text: l.replace(/^\S+Z /, ""), at: Date.parse(l.split(" ")[0]) || undefined }));
			return { id: "log", title: job?.title ?? "Log", description: tilde(engine.store.logFile(d.jobId)), wide: true, children: [{ type: "log", id: "job-log", lines: lines.slice(-600), follow: true, empty: "The log is empty or was removed." }] };
		}
		case "history": {
			const it = engine.item(d.itemId);
			const entries = engine.audit.filter((e) => e.item === d.itemId).slice(-200).reverse();
			return { id: "history", title: `${it?.name ?? "Item"}: history`, description: `${entries.length} events, newest first. Every check and update attempt is recorded.`, wide: true, children: [{ type: "log", id: "history-log", lines: entries.map((e) => ({ at: e.at, text: `${new Date(e.at).toLocaleDateString()}  ${EVENT[e.event].padEnd(9)} ${e.text}${e.by ? `  (${BY[e.by]})` : ""}`, tone: e.tone === "default" || e.tone === "info" ? undefined : e.tone })), empty: "Nothing yet." }] };
		}
		case "recipe": {
			const r = d.draft;
			const ready = !!(r.name.trim() && r.version.trim() && r.latest.trim() && r.update.trim());
			return {
				id: "recipe",
				title: "Add a custom recipe",
				description: "Three shell commands. They're shown exactly as they'll run; Upkeep fingerprints them, and editing any of them needs a new review.",
				wide: true,
				children: [
					{
						type: "form",
						id: "recipe",
						fields: [
							{ type: "text", id: "name", label: "Name", value: r.name, placeholder: "My tool" },
							{ type: "text", id: "version", label: "Prints the installed version", value: r.version, placeholder: "mytool --version" },
							{ type: "text", id: "latest", label: "Prints the newest version", value: r.latest, placeholder: "curl -s https://example.com/latest.txt" },
							{ type: "text", id: "update", label: "Updates it", value: r.update, placeholder: "mytool self-update" },
							{ type: "text", id: "repo", label: "GitHub repository (optional)", value: r.repo, placeholder: "owner/repo — for release notes" },
						],
					},
					{ type: "card", title: "What will run", tone: "warning", description: "Checks run on the schedule; the update runs only when you start it. Read them carefully.", children: [{ type: "log", id: "recipe-cmds", lines: [{ text: `# check: $ ${r.version || "…"}` }, { text: `# check: $ ${r.latest || "…"}` }, { text: `# update: $ ${r.update || "…"}`, tone: "warning" }] }] },
				],
				actions: [{ id: "recipe-save", label: "I've read them: add", primary: true, disabled: !ready }],
			};
		}
	}
}

function reviewDialog(engine: Engine, r: Review): Dialog | undefined {
	const it = engine.item(r.itemId);
	if (!it) return undefined;
	const s = it.state;
	const p = provider(it.provider);
	const target = r.target ?? s.latest ?? "?";
	const updatable = s.outdated && !!s.latest;
	const children: Node[] = [];
	const warn = (text: string, tone: Tone = "warning") => children.push({ type: "text", text, tone });
	if (r.error) warn(`Couldn't prepare the update: ${r.error}`, "danger");
	if (updatable) {
		if (stepOf(it) === "major") warn(`${target} is a major update: it may change how ${it.name} works. Read the notes.`);
		if (it.provider !== "git" && isPrerelease(target)) warn(`${target} is a pre-release.`);
		if (s.blocked) warn(`Can't update now: ${s.blocked}.`, "danger");
		if (r.plan?.unverified) warn("These are your own commands, run in a shell. Upkeep can't vouch for them.", "danger");
		if (r.plan?.needsAuth && !r.plan.handoff) warn("This needs your administrator password. When it asks, a macOS dialog from Upkeep appears; the password goes straight to sudo and isn't stored. Prefer to type it yourself? Use “Run in Terminal”.");
		if (r.plan?.app) warn(`${r.plan.app.name} will be asked to quit if it's running (it may ask you to save first).`);
		if (r.plan?.handoff) warn(r.plan.handoff, "info");
		for (const w of r.plan?.warnings ?? []) warn(w, "muted");
	}
	if (s.eol?.past) warn(`This version line reached end of life${s.eol.at ? ` on ${s.eol.at}` : ""}: no more security fixes.${s.beyond ? ` ${s.beyond} is the newest outside your channel.` : ""}`, "danger");
	else if (s.beyond) warn(`${s.beyond} is newer, outside your channel (${s.channel}). Change the channel in the item's settings to move to it.`, "info");
	if (updatable && r.plan)
		children.push({
			type: "card",
			title: "What will run",
			children: [
				{ type: "log", id: "plan", lines: r.plan.steps.map((st) => ({ text: `$ ${st.label ?? show(st.argv)}` })) },
				{ type: "details", items: [{ label: "From → to", value: `${s.installed ?? "?"} → ${target}`, mono: true }, { label: "Provider", value: p?.label ?? it.provider }, { label: "Afterwards", value: r.plan.handoff ? "Upkeep checks again in 10 minutes" : `Upkeep checks the version${r.plan.app ? " and the app's signature" : ""}` }] },
			],
		});
	if (r.loading) children.push({ type: "progress", label: "Reading release notes…" });
	else if (r.notesError) children.push({ type: "text", text: `Couldn't read release notes: ${r.notesError}`, tone: "muted" });
	else if (r.notes?.length) {
		children.push({ type: "text", text: `Release notes: ${r.notes.length} version${r.notes.length > 1 ? "s" : ""} since ${s.installed ?? "yours"}, newest first.`, tone: "muted" });
		for (const n of r.notes)
			children.push({ type: "card", title: n.version, description: [n.date, n.url].filter(Boolean).join(" · "), children: [{ type: "markdown", text: n.body.length > 12_000 ? n.body.slice(0, 12_000) + "\n\n… (shortened)" : n.body || "_No notes for this version._" }] });
	} else if (!r.loading) children.push({ type: "text", text: `No release notes found${s.homepage ? `. See ${s.homepage}` : "."}`, tone: "muted" });

	const actions: Action[] = [];
	if (updatable && !it.skip) actions.push({ id: "skip", label: `Skip ${target}` });
	if (updatable && r.plan && !r.plan.handoff && !r.plan.unverified && r.plan.steps.length) actions.push({ id: "terminal", label: "Run in Terminal", icon: "square-terminal" });
	if (updatable) actions.push({ id: "update", label: r.plan?.handoff ? "Open" : "Update now", icon: "download", primary: true, disabled: r.loading || !r.plan || !!s.blocked });
	return { id: "review", title: updatable ? `${it.name}: ${s.installed ?? "?"} → ${target}` : `${it.name}: release notes`, description: p?.label, wide: true, children, actions };
}
