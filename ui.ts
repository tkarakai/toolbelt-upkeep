// Upkeep's screens, built from the engine's state. Dialogs belong to the screen they were
// opened on.
//
// The flow: work you start shows its progress where you started it (a run card at the top of
// the screen, a pulsing dot on the row, the review dialog turning into a live log) and ends
// with one summary of what changed. Activity is the one timeline: what's running now on top,
// then history, one entry per run with its jobs inside.
import type { Action, Dialog, Filter, GroupLabel, LogLine, Node, Row, Tone } from "@toolbelt/sdk";
import { relative } from "@toolbelt/sdk";
import { bulkUpdatable, hasUpdate, stepOf, type Engine, type Job, type Run } from "./lib/engine";
import { show, tilde } from "./lib/exec";
import type { AuditEntry } from "./lib/store";
import { KIND_LABEL, POLICY_LABEL, type Candidate, type Item, type Kind, type Note, type Plan } from "./lib/types";
import { isPrerelease } from "./lib/version";
import { PROVIDERS, provider } from "./providers";

export type Review = { itemId: string; target?: string; loading: boolean; plan?: Plan; notes?: Note[]; error?: string; notesError?: string; /** The update started from this dialog. */ jobId?: string };
export type RecipeDraft = { name: string; version: string; latest: string; update: string; repo: string };
export type UI = {
	query: Record<string, string>;
	/** Per surface, per filter id: the checked options. */
	filters: Record<string, Record<string, string[]>>;
	/** The open dialog and the screen it's on. */
	dialog: null | ({ surface: string } & ({ kind: "review"; review: Review } | { kind: "bulk" } | { kind: "settings"; itemId: string } | { kind: "log"; jobId: string } | { kind: "history"; itemId: string } | { kind: "recipe"; draft: RecipeDraft }));
};

export const ui: UI = { query: {}, filters: {}, dialog: null };

export const SCREEN = { updates: "screen:monitored", discover: "screen:discover", activity: "screen:activity", settings: "screen:settings" } as const;

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
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const BY: Record<string, string> = { you: "You", schedule: "Schedule", auto: "Automatic" };
const active = (j: Job) => j.state === "running" || j.state === "queued";
const selected = (surface: string, filter: string) => ui.filters[surface]?.[filter] ?? [];

function jobFor(engine: Engine, itemId: string) {
	return engine.jobs.find((j) => j.itemId === itemId && active(j));
}

/** The newest line of a running job worth showing as its progress. */
const progressLine = (j: Job) => [...j.lines].reverse().find((l) => l.tone !== "muted" && !l.text.startsWith("GET "))?.text ?? (j.state === "queued" ? "Waiting…" : "Starting…");

// ── status: one place decides where an item belongs and what you can do ──
type Section = "busy" | "attention" | "ready" | "review" | "new" | "ok" | "held";
const SECTIONS: Record<Section, { label: string; icon: string }> = {
	busy: { label: "In progress", icon: "loader" },
	attention: { label: "Needs you", icon: "circle-alert" },
	ready: { label: "Ready to update", icon: "download" },
	review: { label: "Review first", icon: "file-search" },
	new: { label: "Not checked yet", icon: "circle-dashed" },
	ok: { label: "Up to date", icon: "circle-check" },
	held: { label: "Held back", icon: "pin" },
};
const SECTION_ORDER = Object.keys(SECTIONS) as Section[];

type Status = { section: Section; tone: Tone; text: string; pulse?: boolean };

/** Why an update isn't in the one-click batch. */
export function reviewReason(it: Item): string | null {
	if (!hasUpdate(it) || bulkUpdatable(it)) return null;
	if (it.state.blocked) return it.state.blocked;
	if (it.state.needsAuth || it.data.auth) return "needs your password";
	if (it.provider === "custom") return "your own command";
	if (it.provider === "sparkle" || it.provider === "go") return "updates in its own app";
	if (it.kind === "app") return "an app: quits it if running";
	if (stepOf(it) === "major") return "major version";
	return "needs review";
}

export function statusOf(engine: Engine, it: Item): Status {
	const job = jobFor(engine, it.id);
	const s = it.state;
	if (job && job.type !== "check") return { section: "busy", tone: "info", pulse: true, text: job.state === "running" ? `${job.type === "rollback" ? "Rolling back" : "Updating"}… ${progressLine(job)}` : "Waiting to update…" };
	const checking = job ? { pulse: true, text: job.state === "running" ? "Checking…" : "Waiting to check…" } : null;
	const missing = engine.discovered?.diff?.missing.includes(it.id);
	let st: Status;
	if (s.error) st = { section: "attention", tone: "danger", text: `Check failed (${s.failures}×): ${s.error}` };
	else if (s.eol?.past) st = { section: "attention", tone: "danger", text: "End of life: no more security fixes" };
	else if (hasUpdate(it) && (s.blocked || s.needsAuth)) st = { section: "attention", tone: "warning", text: s.blocked ?? "Needs your password" };
	else if (hasUpdate(it) && bulkUpdatable(it)) st = { section: "ready", tone: "warning", text: "Update available" };
	else if (hasUpdate(it)) st = { section: "review", tone: "warning", text: `Update available: ${reviewReason(it)}` };
	else if (s.blocked) st = { section: "attention", tone: "warning", text: s.blocked };
	else if (missing) st = { section: "attention", tone: "warning", text: "Not found by the last scan: uninstalled?" };
	else if (s.outdated) st = { section: "held", tone: "muted", text: it.pinned ? `Pinned at ${s.installed}` : `Skipping ${s.latest}` };
	else if (!s.checkedAt) st = { section: "new", tone: "muted", text: "Not checked yet" };
	else st = { section: "ok", tone: "success", text: "Up to date" };
	return checking ? { ...st, ...checking } : st;
}

function chips(engine: Engine, it: Item): string[] {
	const s = it.state;
	const out: string[] = [];
	if (hasUpdate(it) && stepOf(it) === "major") out.push("major");
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

const appIcon = (it: Item | Candidate) => (typeof it.data?.app === "string" ? `app:${it.data.app}` : undefined);

// ── update actions: one click by default, review on the side ─────────────
// Rows choose one of these; they differ only in what the confirmation says.
const REVIEW: Action = { id: "review", label: "Review & update…", icon: "file-search", key: "v" };
const updateAction = (id: string, confirm?: string): Action => ({ id, label: "Update", icon: "download", inline: true, primary: true, key: "u", group: "update", ...(confirm && { confirm }), menu: [REVIEW] });
export const UPDATE_ACTIONS: Action[] = [
	updateAction("update"),
	updateAction("update-app", "The app is asked to quit first if it's running (it may ask you to save). Use “Review & update…” to read the notes first."),
	updateAction("update-major", "This is a major update: it may change how it works. Use “Review & update…” to read the notes first."),
	updateAction("update-auth", "This needs your administrator password: a macOS dialog from Upkeep asks for it. The password goes straight to sudo and isn't stored."),
	updateAction("update-own", "This runs your own command in a shell, exactly as you reviewed it."),
	updateAction("update-open", "This opens the app's own updater; Upkeep checks the version again in 10 minutes."),
];
export const UPDATE_IDS = new Set(UPDATE_ACTIONS.map((a) => a.id));

/** Which update action (and so which confirmation) fits this item. */
export function updateActionFor(it: Item): string {
	if (it.provider === "custom") return "update-own";
	if (it.provider === "sparkle" || it.provider === "go") return "update-open";
	if (it.state.needsAuth || it.data.auth) return "update-auth";
	if (it.kind === "app") return "update-app";
	if (stepOf(it) === "major") return "update-major";
	return "update";
}

// ── run cards: progress where you started it, then the outcome ───────────
const RUN_VISIBLE_MS = 20 * 60_000;

function jobDot(j: Job): { color: Tone; pulse?: boolean } {
	if (j.state === "running") return { color: "info", pulse: true };
	if (j.state === "queued") return { color: "muted" };
	return { color: j.tone ?? (j.state === "failed" ? "danger" : j.state === "cancelled" ? "muted" : "success") };
}

/** Runs started on this surface that are still going, or finished recently and not dismissed. */
export function visibleRuns(engine: Engine, surface: string): Run[] {
	return engine.runs.filter((r) => r.surface === surface && !r.dismissed && (!r.endedAt || Date.now() - r.endedAt < RUN_VISIBLE_MS)).slice(-3).reverse();
}

function runCard(engine: Engine, r: Run): Node {
	const jobs = engine.jobsOf(r);
	const done = jobs.filter((j) => !active(j)).length;
	const running = !r.endedAt;
	const children: Node[] = [];
	if (running) {
		const current = jobs.find((j) => j.state === "running");
		children.push({ type: "progress", label: current ? `${jobs.length > 1 ? `${current.itemId ? (engine.item(current.itemId)?.name ?? "") : ""}: ` : ""}${progressLine(current)}` : "Waiting for other work to finish…", value: jobs.length > 1 ? done / jobs.length : undefined, at: r.startedAt });
	}
	if (jobs.length > 1) {
		// Unfinished and failed work first: that's what you look for.
		const rank = (j: Job) => (j.state === "running" ? 0 : j.state === "failed" || j.tone === "danger" || j.tone === "warning" ? 1 : j.state === "queued" ? 2 : 3);
		const list = [...jobs].sort((a, b) => rank(a) - rank(b));
		children.push({
			type: "list",
			id: `jobs-${r.id}`,
			items: list.slice(0, 8).map((j) => ({ id: j.id, title: j.itemId ? (engine.item(j.itemId)?.name ?? j.title) : j.title, subtitle: active(j) ? (j.state === "queued" ? "Waiting…" : progressLine(j)) : (j.result ?? j.state), dot: jobDot(j), actions: [{ id: "log", label: "Show log", icon: "scroll-text" }] })),
		});
		if (list.length > 8) children.push({ type: "text", text: `…and ${list.length - 8} more in Activity.`, tone: "muted" });
	} else if (jobs[0] && (running || jobs[0].state === "failed")) {
		children.push({ type: "log", id: `log-${r.id}`, lines: jobs[0].lines.slice(-8) as LogLine[], follow: true });
	}
	if (r.diff && r.endedAt) children.push(...scanDiffNodes(engine, r));
	const actions: Action[] = running
		? [{ id: "run-cancel", label: jobs.length > 1 ? "Cancel the rest" : "Cancel", icon: "square", tone: "destructive", confirm: r.kind === "update" || r.kind === "rollback" ? "Stop this work? Waiting items don't start and the running one is stopped. Finished updates stay; Upkeep can't undo a half-run command." : undefined }]
		: [{ id: "run-dismiss", label: "Dismiss", icon: "x" }, ...(r.kind === "scan" && r.surface !== SCREEN.discover ? [{ id: "run-discover", label: "Choose what to watch", icon: "radar", primary: true }] : [{ id: "run-activity", label: "Show in Activity", icon: "clock" }])];
	return {
		type: "card",
		id: r.id,
		title: r.title,
		description: running ? `${jobs.length > 1 ? `${done} of ${jobs.length} · ` : ""}${r.kind === "scan" ? "Scanning only reads" : "You can leave this screen; it keeps going"}` : `${r.summary?.text ?? "Finished"} · ${relative(r.endedAt!)}`,
		tone: running ? "info" : (r.summary?.tone ?? "success"),
		actions,
		children,
	};
}

function scanDiffNodes(engine: Engine, r: Run): Node[] {
	const d = r.diff!;
	if (d.prevAt === undefined && !d.missing.length) return [];
	const name = (id: string) => engine.discovered?.candidates.find((c) => c.id === id)?.name ?? engine.item(id)?.name ?? id;
	const list = (ids: string[]) => (ids.length > 6 ? `${ids.slice(0, 6).join(", ")} +${ids.length - 6}` : ids.join(", "));
	const items = [
		...(d.added.length ? [{ label: "New", value: list(d.added.map(name)) }] : []),
		...(d.gone.length ? [{ label: "Gone", value: list(d.gone.map((c) => c.name)) }] : []),
		...(d.changed.length ? [{ label: "Changed version", value: list(d.changed.map((c) => `${name(c.id)} ${c.from ?? "?"} → ${c.to ?? "?"}`)) }] : []),
		...(d.missing.length ? [{ label: "Watched, not found", value: list(d.missing.map(name)), tone: "warning" as Tone }] : []),
	];
	if (!items.length) return [{ type: "text", text: `Nothing changed since the scan ${relative(d.prevAt!)}.`, tone: "muted" }];
	return [{ type: "details", items }];
}

// ── Updates (screen id: monitored) ───────────────────────────────────────
export function monitored(engine: Engine, surface: string): Node {
	const q = ui.query[surface];
	const kinds = selected(surface, "kind");
	const all = engine.items.filter((it) => matches(q, it.name, it.location, it.provider, it.state.installed));
	const items = all.filter((it) => !kinds.length || kinds.includes(it.kind));
	const updates = engine.updates();
	const safe = updates.filter(bulkUpdatable);
	const status = new Map(engine.items.map((it) => [it.id, statusOf(engine, it)]));
	const rows: Row[] = [...items]
		.sort((a, b) => SECTION_ORDER.indexOf(status.get(a.id)!.section) - SECTION_ORDER.indexOf(status.get(b.id)!.section) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name))
		.map((it) => itemRow(engine, it, status.get(it.id)!));
	const attention = items.filter((it) => status.get(it.id)!.section === "attention").length;
	const bits = [`${engine.items.length} watched`, updates.length ? plural(updates.length, "update") : "all up to date", attention ? `${attention} need${attention === 1 ? "s" : ""} you` : ""].filter(Boolean);
	const kindFilter: Filter = { id: "kind", label: "Kind", icon: "shapes", options: KIND_ORDER.filter((k) => all.some((i) => i.kind === k)).map((k) => ({ value: k, label: KIND_LABEL[k], count: all.filter((i) => i.kind === k).length })), selected: kinds };
	return page(surface, {
		type: "page",
		search: { placeholder: "Filter by name, folder, provider…" },
		filters: engine.items.length ? [kindFilter] : undefined,
		summary: engine.items.length ? bits.join(" · ") : "",
		actions: engine.items.length
			? [
					{ id: "check-all", label: "Check all", icon: "refresh-cw" },
					{ id: "update-safe", label: safe.length ? `Update ${safe.length} ready` : "Nothing ready", icon: "download", primary: safe.length > 0, disabled: !safe.length, menu: [{ id: "review-safe", label: "Review them first…", icon: "file-search", disabled: !safe.length }] },
				]
			: [{ id: "scan", label: "Scan this Mac", icon: "radar", primary: true, disabled: engine.jobs.some((j) => j.type === "scan" && active(j)) }],
		children: [
			...visibleRuns(engine, surface).map((r) => runCard(engine, r)),
			{
				type: "table",
				id: "items",
				columns: [
					{ key: "name", title: "Name", grow: true },
					{ key: "installed", title: "Installed", mono: true },
					{ key: "latest", title: "Newest" },
					{ key: "status", title: "Status", optional: true, maxWidth: 320 },
					{ key: "checked", title: "Checked", align: "right", optional: true },
				],
				rows,
				actions: [
					...UPDATE_ACTIONS,
					{ id: "check", key: "c", label: "Check now", icon: "refresh-cw", inline: true, group: "update" },
					REVIEW,
					{ id: "notes", key: "n", label: "Release notes", icon: "file-text", group: "update" },
					{ id: "settings", key: "e", label: "Settings…", icon: "sliders-horizontal", group: "item" },
					{ id: "history", key: "h", label: "History", icon: "clock", group: "item" },
					{ id: "skip", key: "s", label: "Skip this version", icon: "skip-forward", group: "item" },
					{ id: "pin", key: "p", label: "Pin at this version", icon: "pin", group: "item" },
					{ id: "unpin", key: "p", label: "Unpin", icon: "pin-off", group: "item" },
					{ id: "rollback", key: "r", label: "Roll back", icon: "undo-2", group: "item", confirm: "Go back to the version before the last update?" },
					{ id: "remove", key: "x", label: "Stop watching", icon: "trash", tone: "destructive", confirm: "Stop watching this? Nothing is uninstalled." },
				],
				bulkActions: [
					{ id: "update-many", label: "Update", icon: "download", primary: true },
					{ id: "check-many", label: "Check now", icon: "refresh-cw" },
					{ id: "remove-many", label: "Stop watching", icon: "trash", tone: "destructive", confirm: "Stop watching the selected items? Nothing is uninstalled." },
				],
				empty: q || kinds.length ? { title: "Nothing matches", icon: "search-x" } : { title: "Nothing watched yet", description: "Scan this Mac, then choose what Upkeep should keep up to date in Discover. Scanning only reads; nothing is checked or changed until you choose.", icon: "radar" },
			},
		],
	});
}

function itemRow(engine: Engine, it: Item, st: Status): Row {
	const s = it.state;
	const p = provider(it.provider);
	const recipe = p?.recipe(it);
	const job = jobFor(engine, it.id);
	const canRollback = !!(s.previous && p?.rollback?.(it, s.previous));
	const update = hasUpdate(it) && !s.blocked && !(job && job.type !== "check");
	const recent = engine.audit.filter((e) => e.item === it.id && e.event !== "started").slice(-5).reverse();
	const section: GroupLabel = { id: st.section, label: SECTIONS[st.section].label, icon: SECTIONS[st.section].icon, muted: st.section === "ok" || st.section === "held" };
	return {
		id: it.id,
		group: [section],
		cells: {
			name: { text: it.name, sub: it.location ?? p?.label, dot: { color: st.tone, pulse: st.pulse, label: st.text }, icon: appIcon(it) },
			installed: { text: s.installed ?? "—", mono: true },
			latest: { text: s.latest ?? "—", mono: true, tone: hasUpdate(it) ? "warning" : s.outdated ? "muted" : "default", chips: chips(engine, it) },
			status: { text: st.text, tone: st.tone === "success" ? "muted" : st.tone },
			checked: s.checkedAt ? { text: "", at: s.checkedAt, tone: "muted" } : { text: "never", tone: "muted" },
		},
		actions: [
			...(update ? [updateActionFor(it)] : []),
			"check",
			...(s.outdated && !update ? ["review"] : []),
			...(!s.outdated ? ["notes"] : []),
			"settings",
			"history",
			...(s.outdated && !it.skip ? ["skip"] : []),
			it.pinned ? "unpin" : "pin",
			...(canRollback ? ["rollback"] : []),
			"remove",
		],
		details: [
			...(job
				? [
						{ section: "Now", label: job.type === "check" ? "Checking" : job.type === "rollback" ? "Rolling back" : "Updating", value: progressLine(job), dot: { color: "info" as Tone, pulse: true } },
						...(job.startedAt ? [{ section: "Now", label: "Started", value: relative(job.startedAt) }] : []),
					]
				: []),
			{ section: "Status", label: "Status", value: st.text, tone: st.tone === "success" ? undefined : st.tone },
			{ section: "Status", label: "Installed → newest", value: `${s.installed ?? "?"} → ${s.latest ?? "?"}`, mono: true },
			...(s.error ? [{ section: "Status", label: "Last error", value: `${s.error} (${s.failures} in a row; retrying ${relative(s.nextAt)})`, tone: "danger" as Tone }] : []),
			...(s.eol ? [{ section: "Status", label: "End of life", value: s.eol.past ? `Yes${s.eol.at ? `, since ${s.eol.at}` : ""}` : (s.eol.at ?? "—") }] : []),
			...(s.beyond ? [{ section: "Status", label: "Outside your channel", value: `${s.beyond} is newer (change the channel in Settings…)` }] : []),
			...(s.previous ? [{ section: "Status", label: "Before the last update", value: s.previous, mono: true }] : []),
			...(s.updatedAt ? [{ section: "Status", label: "Last updated", value: when(s.updatedAt) }] : []),
			{ section: "Schedule", label: "Last check", value: `${when(s.checkedAt)}${s.checkMs ? ` · took ${(s.checkMs / 1000).toFixed(1)} s` : ""}` },
			{ section: "Schedule", label: "Next check", value: job ? "now" : when(s.nextAt) },
			{ section: "Schedule", label: "Policy", value: `${POLICY_LABEL[it.policy]}${it.policy !== "notify" && !engine.settings.autoUpdates ? " (automatic updates are off in Settings)" : ""}` },
			...(it.channel ? [{ section: "Schedule", label: "Channel", value: it.channel }] : []),
			{ section: "How it updates", label: "Provider", value: p?.label ?? it.provider },
			{ section: "How it updates", label: "Checks with", value: recipe?.check ?? "—", mono: true, copy: true },
			{ section: "How it updates", label: "Updates with", value: recipe?.update ?? "—", mono: true, copy: true },
			...(engine.siblings(it).length ? [{ section: "How it updates", label: "Also installed via", value: engine.siblings(it).map((x) => `${provider(x.provider)?.label}: ${x.location ?? x.ref}`).join("\n") }] : []),
			...recent.map((e) => ({ section: "Recent", label: `${EVENT[e.event]} · ${relative(e.at)}`, value: e.text, tone: e.tone === "default" || e.tone === "info" ? undefined : e.tone })),
			...(it.location ? [{ section: "About", label: "Where", value: it.location, mono: true, copy: true }] : []),
			...(it.description ? [{ section: "About", label: "About", value: it.description }] : []),
			...(s.homepage ? [{ section: "About", label: "Release notes", value: s.homepage, mono: true }] : []),
			{ section: "About", label: "Watching since", value: when(it.addedAt) },
		],
	};
}

// ── Discover ─────────────────────────────────────────────────────────────
export function discover(engine: Engine, surface: string): Node {
	const q = ui.query[surface];
	const d = engine.discovered;
	const diff = d?.diff;
	const scanning = engine.jobs.some((j) => j.type === "scan" && active(j));
	const byIdentity = new Map<string, Candidate[]>();
	for (const c of d?.candidates ?? []) byIdentity.set(c.identity, [...(byIdentity.get(c.identity) ?? []), c]);
	const label = (c: { provider: string }) => provider(c.provider)?.label ?? c.provider;
	const order = (c: { provider: string }) => PROVIDERS.findIndex((p) => p.id === c.provider);
	const added = new Set(diff?.prevAt !== undefined ? diff.added : []);
	const changed = new Map((diff?.changed ?? []).map((c) => [c.id, c]));
	const SECTION = { missing: "Watched, not found", new: "New since last scan", unwatched: "Not watched", watching: "Watching", gone: "Gone since last scan" } as const;
	const sectionOrder = Object.values(SECTION) as string[];
	const group = (section: string, c: { provider: string }): GroupLabel[] => [{ id: section, label: section, muted: section === SECTION.gone || section === SECTION.watching }, label(c)];
	const rows: (Row & { sort: [number, number, string] })[] = [];
	for (const c of d?.candidates ?? []) {
		if (!matches(q, c.name, c.location, c.description, label(c))) continue;
		const watched = !!engine.item(c.id);
		const others = (byIdentity.get(c.identity) ?? []).filter((x) => x.id !== c.id);
		const section = watched ? SECTION.watching : added.has(c.id) ? SECTION.new : SECTION.unwatched;
		const ch = changed.get(c.id);
		rows.push({
			id: c.id,
			group: group(section, c),
			sort: [sectionOrder.indexOf(section), order(c), c.name],
			cells: {
				name: { text: c.name, sub: c.location, dot: watched ? "success" : section === SECTION.new ? "info" : others.length ? "warning" : "muted", icon: appIcon(c) },
				version: { text: c.installed ?? "—", mono: true, sub: ch ? `was ${ch.from ?? "?"}` : undefined },
				notes: { text: watched ? "Watching" : (c.note ?? ""), tone: watched ? "success" : "muted", chips: [...(section === SECTION.new ? ["new"] : []), ...others.map((o) => `also: ${label(o)}`)] },
			},
			actions: watched ? ["remove"] : ["monitor"],
			details: [
				{ label: "Where", value: c.location ?? "—", mono: true },
				...(c.description ? [{ label: "About", value: c.description }] : []),
				{ label: "Version", value: ch ? `${c.installed ?? "—"} (was ${ch.from ?? "?"})` : (c.installed ?? "—"), mono: true },
				...(others.length ? [{ label: "Also installed via", value: others.map((o) => `${label(o)}: ${o.location ?? o.ref}`).join("\n") }] : []),
				...(c.note ? [{ label: "Note", value: c.note }] : []),
			],
		});
	}
	// Watched items the last scan didn't find: probably uninstalled.
	for (const id of diff?.missing ?? []) {
		const it = engine.item(id);
		if (!it || !matches(q, it.name, it.location, label(it))) continue;
		rows.push({
			id: it.id,
			group: group(SECTION.missing, it),
			sort: [sectionOrder.indexOf(SECTION.missing), order(it), it.name],
			cells: { name: { text: it.name, sub: it.location, dot: "warning", icon: appIcon(it) }, version: { text: it.state.installed ?? "—", mono: true }, notes: { text: "Not found: uninstalled or moved?", tone: "warning" } },
			actions: ["remove"],
			details: [{ label: "Where", value: it.location ?? "—", mono: true }, { label: "What to do", value: "If you uninstalled it, stop watching it. If it moved, scan again after it's back or watch it at its new place." }],
		});
	}
	// Found last time, gone now (not watched): for the record.
	for (const c of diff?.gone ?? []) {
		if (engine.item(c.id) || !matches(q, c.name, c.location, label(c))) continue;
		rows.push({ id: `gone:${c.id}`, group: group(SECTION.gone, c), sort: [sectionOrder.indexOf(SECTION.gone), order(c), c.name], cells: { name: { text: c.name, sub: c.location, dot: "muted" }, version: { text: c.installed ?? "—", mono: true }, notes: { text: "No longer found", tone: "muted" } }, actions: [], details: [{ label: "Where it was", value: c.location ?? "—", mono: true }] });
	}
	rows.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2].localeCompare(b.sort[2]));
	const freshNew = [...added].filter((id) => !engine.item(id));
	const errors = Object.entries(d?.errors ?? {});
	const summary = scanning ? "Scanning this Mac…" : d ? [`${d.candidates.length} found ${relative(d.at)}`, errors.length ? `${errors.length} provider${errors.length > 1 ? "s" : ""} failed: ${errors.map(([p]) => provider(p)?.label ?? p).join(", ")}` : ""].filter(Boolean).join(" · ") : "";
	return page(surface, {
		type: "page",
		search: { placeholder: "Filter by name, folder, provider…" },
		summary,
		actions: [
			...(freshNew.length ? [{ id: "monitor-new", label: `Watch ${freshNew.length} new`, icon: "eye" }] : []),
			{ id: "scan", label: d ? "Scan again" : "Scan this Mac", icon: "radar", primary: !d, disabled: scanning },
		],
		children: [
			...visibleRuns(engine, surface).map((r) => runCard(engine, r)),
			{
				type: "table",
				id: "candidates",
				columns: [
					{ key: "name", title: "Name", grow: true },
					{ key: "version", title: "Version", mono: true },
					{ key: "notes", title: "" },
				],
				rows: rows.map(({ sort: _, ...r }) => r),
				actions: [
					{ id: "monitor", key: "w", label: "Watch", icon: "eye", inline: true },
					{ id: "remove", key: "x", label: "Stop watching", icon: "eye-off", inline: true },
				],
				bulkActions: [{ id: "monitor-many", label: "Watch selected", icon: "eye", primary: true }],
				empty: scanning
					? { title: "Scanning…", description: "Looking at Homebrew, apps, runtimes, global packages and git clones.", icon: "radar" }
					: q && d
						? { title: "Nothing matches", icon: "search-x" }
						: { title: "Find what can be kept up to date", description: "Scanning only reads: it lists Homebrew packages, apps that update with Sparkle, runtimes, global packages and git clones. You choose what to watch. Each scan shows what's new or gone since the last one.", icon: "radar" },
			},
		],
	});
}

// ── Activity: now, then history (one entry per run) ──────────────────────
const EVENT: Record<AuditEntry["event"], string> = { added: "Watching", removed: "Removed", changed: "Changed", scan: "Scan", check: "Check", update: "Update", rollback: "Rollback", skipped: "Skipped", cancelled: "Cancelled", started: "Started", run: "Run" };
const WHAT: Record<string, AuditEntry["event"][]> = { updates: ["update", "rollback", "skipped", "cancelled"], checks: ["check"], scans: ["scan"], changes: ["added", "removed", "changed"] };
const WHAT_LABEL: Record<string, string> = { updates: "Updates & rollbacks", checks: "Checks", scans: "Scans", changes: "Watching & settings" };
const kindOfRun = (e: AuditEntry) => (e.detail?.kind === "check" ? "checks" : e.detail?.kind === "scan" ? "scans" : "updates");
const whatOf = (e: AuditEntry) => (e.event === "run" ? kindOfRun(e) : (Object.entries(WHAT).find(([, ev]) => ev.includes(e.event))?.[0] ?? "changes"));

/** Activity row ids: a run, or an entry (its job id last). */
export const runRowId = (runId: string) => `run|${runId}`;
const entryRowId = (e: AuditEntry) => `${e.at}|${e.event}|${e.item ?? ""}|${e.job ?? ""}`;

function nowSection(engine: Engine): Node[] {
	const running = engine.jobs.filter((j) => j.state === "running");
	const waiting = engine.jobs.filter((j) => j.state === "queued");
	if (!running.length && !waiting.length) return [];
	const out: Node[] = running.map((j) => {
		const r = engine.runOf(j);
		const of = r && r.jobs.length > 1 ? ` · ${r.title}` : "";
		return {
			type: "card",
			id: j.id,
			title: j.title,
			description: `${BY[j.by]}${of}`,
			tone: "info",
			actions: [{ id: "cancel", label: "Cancel", icon: "square", tone: "destructive", confirm: j.type === "update" || j.type === "rollback" ? "Stop this update? Upkeep can't undo a half-run command." : undefined }],
			children: [
				{ type: "progress", label: progressLine(j), at: j.startedAt },
				{ type: "log", id: `log-${j.id}`, lines: j.lines.slice(-300) as LogLine[], follow: true },
			],
		} satisfies Node;
	});
	if (waiting.length)
		out.push({
			type: "card",
			title: `Waiting (${waiting.length})`,
			description: "One job at a time per provider, three at once in all.",
			children: [{ type: "list", id: "waiting", items: waiting.map((j) => ({ id: j.id, title: j.title, subtitle: [BY[j.by], engine.runOf(j)?.jobs.length! > 1 ? engine.runOf(j)!.title : ""].filter(Boolean).join(" · "), dot: "muted" as Tone, metaAt: j.queuedAt, actions: [{ id: "cancel", label: "Cancel", icon: "x" }] })) }],
		});
	return out;
}

function entryRow(engine: Engine, e: AuditEntry): Row {
	return {
		id: entryRowId(e),
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
			...(e.job ? [{ label: "Log", value: tilde(engine.store.logFile(e.job)), mono: true, copy: true }] : []),
		],
	};
}

export function activity(engine: Engine, surface: string): Node {
	const q = ui.query[surface];
	const what = selected(surface, "what");
	const by = selected(surface, "by");
	// "started" entries from older versions repeat their update's entry: leave them out.
	const all = engine.audit.filter((e) => e.event !== "started").slice(-1500);
	const runs = new Map(all.filter((e) => e.event === "run" && e.run).map((e) => [e.run!, e]));
	const children = new Map<string, AuditEntry[]>();
	const top: AuditEntry[] = [];
	for (const e of all) {
		if (e.event !== "run" && e.run && runs.has(e.run)) children.set(e.run, [...(children.get(e.run) ?? []), e]);
		else top.push(e);
	}
	const keep = (e: AuditEntry, kids: AuditEntry[] = []) => (!what.length || what.includes(whatOf(e))) && (!by.length || (e.by && by.includes(e.by))) && (matches(q, e.name, e.text, EVENT[e.event], e.by) || kids.some((k) => matches(q, k.name, k.text)));
	const rows: Row[] = top
		.filter((e) => keep(e, e.event === "run" ? children.get(e.run!) : undefined))
		.reverse()
		.map((e) => {
			if (e.event !== "run") return entryRow(engine, e);
			const kids = (children.get(e.run!) ?? []).slice().reverse();
			const [title, ...rest] = e.text.split(": ");
			const bad = kids.filter((k) => k.tone === "danger" || k.tone === "warning");
			return {
				id: runRowId(e.run!),
				group: day(e.at),
				open: bad.length > 0 && Date.now() - e.at < 86_400_000,
				cells: {
					what: { text: title, sub: rest.join(": "), dot: e.tone, chips: [plural(kids.length, "item")] },
					by: { text: e.by ? BY[e.by] : "", tone: "muted" },
					at: { text: "", at: e.at, tone: "muted" },
				},
				actions: [],
				details: [{ label: "When", value: new Date(e.at).toLocaleString() }, { label: "Outcome", value: rest.join(": ") }, ...(e.by ? [{ label: "Started by", value: BY[e.by] }] : []), ...bad.map((k) => ({ section: "Needs a look", label: k.name ?? EVENT[k.event], value: k.text, tone: k.tone }))],
				children: kids.map((k) => ({ ...entryRow(engine, k), group: undefined })),
			};
		});
	const count = (pred: (e: AuditEntry) => boolean) => top.filter(pred).length;
	const filters: Filter[] = [
		{ id: "what", label: "What", icon: "list-filter", options: Object.keys(WHAT).map((k) => ({ value: k, label: WHAT_LABEL[k], count: count((e) => whatOf(e) === k) })), selected: what },
		{ id: "by", label: "Started by", icon: "user", options: Object.entries(BY).map(([k, label]) => ({ value: k, label, count: count((e) => e.by === k) })), selected: by },
	];
	const next = engine.nextCheck();
	const busy = engine.active().length;
	return page(surface, {
		type: "page",
		search: { placeholder: "Filter the activity…" },
		filters,
		summary: busy ? `${plural(busy, "job")} running or waiting` : `Nothing running · next check ${next ? relative(next) : "—"}`,
		children: [
			...nowSection(engine),
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
				empty: { title: q || what.length || by.length ? "Nothing matches" : "No activity yet", description: "Every scan, check, update and setting change is recorded here.", icon: "clock" },
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
	const safe = updates.filter(bulkUpdatable);
	const next = engine.nextCheck();
	const mine = engine.runs.filter((r) => r.by !== "schedule" && !r.dismissed && (!r.endedAt || Date.now() - r.endedAt < RUN_VISIBLE_MS)).slice(-1);
	const running = engine.jobs.filter((j) => j.state === "running");
	const attention = engine.items.filter((it) => statusOf(engine, it).section === "attention").length;
	const children: Node[] = [
		{
			type: "stats",
			items: [
				{ label: "Updates", value: String(updates.length), tone: updates.length ? "warning" : "success" },
				{ label: "Need you", value: String(attention), tone: attention ? "warning" : undefined },
				running.length ? { label: "Now", value: `${running.length} running` } : { label: "Next check", value: "—", at: next },
			],
		},
	];
	for (const r of mine) {
		const jobs = engine.jobsOf(r);
		const done = jobs.filter((j) => !active(j)).length;
		children.push(
			r.endedAt
				? { type: "text", text: `${r.title}: ${r.summary?.text ?? "finished"}`, tone: r.summary?.tone === "danger" ? "danger" : r.summary?.tone === "warning" ? "warning" : "muted" }
				: { type: "progress", label: `${r.title}${jobs.length > 1 ? ` · ${done} of ${jobs.length}` : ""}`, value: jobs.length > 1 ? done / jobs.length : undefined, at: r.startedAt },
		);
	}
	if (safe.length && !mine.some((r) => !r.endedAt))
		children.push({ type: "card", id: "safe", title: `${plural(safe.length, "update")} ready`, description: safe.map((i) => i.name).slice(0, 4).join(", ") + (safe.length > 4 ? ` +${safe.length - 4}` : ""), actions: [{ id: "update-safe", label: `Update ${safe.length}`, icon: "download", primary: true, menu: [{ id: "review-safe", label: "Review them first…", icon: "file-search" }] }], children: [] });
	children.push({
		type: "list",
		id: "updates",
		items: updates.slice(0, 8).map((it) => {
			const st = statusOf(engine, it);
			const busy = st.section === "busy";
			return {
				id: it.id,
				title: it.name,
				subtitle: busy ? st.text : `${it.state.installed} → ${it.state.latest}${st.section === "attention" ? ` · ${st.text}` : st.section === "review" ? ` · ${reviewReason(it)}` : ""}`,
				dot: { color: busy ? "info" : it.state.eol?.past ? "danger" : "warning", pulse: busy } as const,
				icon: appIcon(it),
				actions: busy || it.state.blocked ? [{ id: "review", label: "Open", icon: "external-link" }] : [{ ...UPDATE_ACTIONS.find((a) => a.id === updateActionFor(it))!, inline: undefined, primary: undefined, key: undefined }],
			};
		}),
		empty: { title: "Everything is up to date", icon: "circle-check" },
	});
	return { type: "stack", gap: 3, children };
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
		case "bulk":
			return bulkDialog(engine);
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
			return { id: "log", title: job?.title ?? "Log", description: tilde(engine.store.logFile(d.jobId)), wide: true, resizable: true, children: [...(job && active(job) ? [{ type: "progress" as const, label: progressLine(job), at: job.startedAt }] : []), { type: "log", id: "job-log", lines: lines.slice(-600), follow: true, empty: "The log is empty or was removed." }], actions: job && active(job) ? [{ id: "cancel-dialog-job", label: "Cancel", icon: "square", tone: "destructive" }] : undefined };
		}
		case "history": {
			const it = engine.item(d.itemId);
			const entries = engine.audit.filter((e) => e.item === d.itemId && e.event !== "started").slice(-200).reverse();
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

/** "Update N ready", reviewed: what will run, and what's left out and why. */
function bulkDialog(engine: Engine): Dialog {
	const updates = engine.updates();
	const safe = updates.filter(bulkUpdatable);
	const left = updates.filter((it) => !bulkUpdatable(it));
	const children: Node[] = [
		{ type: "text", text: "These need no password, quit no app and stay within their major version. Each runs as shown, then Upkeep checks the installed version.", tone: "muted" },
		{
			type: "card",
			title: `Will update (${safe.length})`,
			children: [{ type: "list", id: "bulk-in", items: safe.map((it) => ({ id: it.id, title: it.name, subtitle: `${it.state.installed ?? "?"} → ${it.state.latest ?? "?"}  ·  ${provider(it.provider)?.recipe(it).update ?? ""}`, dot: "warning" as Tone, icon: appIcon(it), actions: [{ id: "review", label: "Release notes", icon: "file-text" }] })), empty: { title: "Nothing ready" } }],
		},
	];
	if (left.length) children.push({ type: "card", title: `Not included (${left.length})`, description: "Update these one at a time from their row.", children: [{ type: "list", id: "bulk-out", items: left.map((it) => ({ id: it.id, title: it.name, subtitle: `${it.state.installed ?? "?"} → ${it.state.latest ?? "?"}  ·  ${reviewReason(it)}`, dot: "muted" as Tone, icon: appIcon(it) })) }] });
	return { id: "bulk", title: `Update ${plural(safe.length, "item")}`, wide: true, children, actions: [{ id: "update-safe", label: `Update ${safe.length}`, icon: "download", primary: true, disabled: !safe.length }] };
}

function reviewDialog(engine: Engine, r: Review): Dialog | undefined {
	const it = engine.item(r.itemId);
	if (!it) return undefined;
	const s = it.state;
	const p = provider(it.provider);
	// Started from here: the dialog follows the update to its result.
	const job = r.jobId ? engine.jobs.find((j) => j.id === r.jobId) : undefined;
	if (job) {
		const running = active(job);
		const failed = job.state === "failed" || job.state === "cancelled";
		return {
			id: "review",
			title: running ? `Updating ${it.name}…` : failed ? `${it.name}: not updated` : `${it.name}: updated`,
			description: p?.label,
			wide: true,
			resizable: true,
			children: [
				running ? { type: "progress", label: progressLine(job), at: job.startedAt } : { type: "text", text: job.result ?? job.state, tone: job.tone === "default" ? undefined : (job.tone ?? (failed ? "danger" : "success")) },
				{ type: "log", id: "update-log", lines: job.lines.slice(-600) as LogLine[], follow: true },
				...(running ? [{ type: "text" as const, text: "You can close this; the update keeps going and shows on its row.", tone: "muted" as Tone }] : []),
			],
			actions: running ? [{ id: "cancel-dialog-job", label: "Cancel", icon: "square", tone: "destructive", confirm: "Stop this update? Upkeep can't undo a half-run command." }] : [{ id: "dialog-done", label: "Done", primary: true }],
		};
	}
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
		for (const n of r.notes) children.push({ type: "card", title: n.version, description: [n.date, n.url].filter(Boolean).join(" · "), children: [{ type: "markdown", text: n.body.length > 12_000 ? n.body.slice(0, 12_000) + "\n\n… (shortened)" : n.body || "_No notes for this version._" }] });
	} else if (!r.loading) children.push({ type: "text", text: `No release notes found${s.homepage ? `. See ${s.homepage}` : "."}`, tone: "muted" });

	const actions: Action[] = [];
	if (updatable && !it.skip) actions.push({ id: "skip", label: `Skip ${target}` });
	const terminal = updatable && r.plan && !r.plan.handoff && !r.plan.unverified && r.plan.steps.length;
	if (updatable) actions.push({ id: "update-now", label: r.plan?.handoff ? "Open" : "Update now", icon: "download", primary: true, disabled: r.loading || !r.plan || !!s.blocked, ...(terminal && { menu: [{ id: "terminal", label: "Run in Terminal instead", icon: "square-terminal" }] }) });
	return { id: "review", title: updatable ? `${it.name}: ${s.installed ?? "?"} → ${target}` : `${it.name}: release notes`, description: p?.label, wide: true, resizable: true, children, actions };
}
