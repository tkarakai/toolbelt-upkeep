// Upkeep: keeps what you choose up to date. See docs/design.md.
//
// Nothing is checked or changed until you choose: a fresh install watches nothing, scanning
// only reads, and updates are "notify only" until you turn automatic updates on (globally and
// per item). Everything is recorded in the audit log (Activity).
import { dataDir, definePlugin, type Context } from "@toolbelt/sdk";
import { Engine, bulkUpdatable, hasUpdate, type Run } from "./lib/engine";
import { initPath, quote, run, show, baseEnv } from "./lib/exec";
import { Store, type Settings } from "./lib/store";
import { POLICY_LABEL, type Item, type Policy } from "./lib/types";
import { customCandidate, recipeHash } from "./providers/custom";
import { provider } from "./providers";
import { activity, bindEngine, discover, monitored, quick, runRowId, SCREEN, settingsScreen, ui, UPDATE_IDS, visibleRuns, type Review } from "./ui";

const store = new Store(dataDir());
let ctx: Context;

// Output can arrive many lines a second: redraw at most every 250 ms.
let pending: ReturnType<typeof setTimeout> | null = null;
const changed = () => {
	if (pending) return;
	pending = setTimeout(() => {
		pending = null;
		ctx?.invalidate();
		const n = engine.updates().length;
		ctx?.badge(n || null);
	}, 250);
};

const engine = new Engine(store, changed);
bindEngine(engine);

// Surfaces someone is looking at: a finished run whose card is in view needs no toast.
const open = new Set<string>();
const screenOf = (surface: string) => surface.replace(/^screen:/, "");

/** Where a run's outcome is best seen. */
function runTarget(r: Run): { screen: string; select?: string } {
	if (r.surface && r.surface.startsWith("screen:") && visibleRuns(engine, r.surface).includes(r)) return { screen: screenOf(r.surface) };
	if (r.jobs.length > 1) return { screen: "activity", select: runRowId(r.id) };
	const job = engine.jobsOf(r)[0];
	if (r.kind === "scan") return { screen: "discover" };
	return { screen: "monitored", select: job?.itemId };
}

engine.onRunDone = (r) => {
	if (!ctx) return;
	if (r.by === "schedule") return; // quiet: the badge and the list say what's new
	if (r.surface && open.has(r.surface) && visibleRuns(engine, r.surface).includes(r)) return;
	if (ui.dialog?.kind === "review" && ui.dialog.review.jobId && r.jobs.includes(ui.dialog.review.jobId)) return;
	const tone = r.summary?.tone === "danger" ? "error" : r.summary?.tone === "success" ? "success" : "default";
	ctx.toast(`${r.by === "auto" ? "Automatic: " : ""}${r.title}: ${r.summary?.text ?? "finished"}`, tone, { id: "show-run", label: "Show", payload: { run: r.id } });
};

/** Start updates as one run, shown where they were started. */
function updateMany(items: Item[], surface: string, title?: string) {
	const list = items.filter((i) => hasUpdate(i) && !i.state.blocked);
	if (!list.length) return null;
	const where = surface === "quick" ? SCREEN.updates : surface;
	return engine.batch("update", list, "you", title ?? (list.length === 1 ? `Update ${list[0].name}` : `Update ${list.length} items`), where, (i) => i.state.latest);
}

// ── review: plan + every release note between installed and newest ──────
async function openReview(surface: string, it: Item) {
	const review: Review = { itemId: it.id, target: it.state.latest, loading: true };
	ui.dialog = { surface, kind: "review", review };
	ctx.invalidate();
	const p = provider(it.provider)!;
	const q = engine.quietCtx();
	const s = it.state;
	if (s.outdated && s.latest) review.plan = await engine.plan(it, s.latest, q).catch((e) => ((review.error = (e as Error).message), undefined));
	try {
		if (p.notes && s.installed) {
			// Up to date: the notes of the version you have (and a few before it).
			const notes = s.outdated && s.latest ? await p.notes(it, s.installed, s.latest, q) : (await p.notes(it, "0", s.installed, q)).slice(0, 5);
			review.notes = notes;
		} else review.notes = [];
	} catch (e) {
		review.notesError = (e as Error).message;
	}
	review.loading = false;
	ctx.invalidate();
}

/** Hand an update to Terminal: you see the command, type the password there if asked. */
async function runInTerminal(it: Item) {
	const plan = await engine.plan(it, it.state.latest!, engine.quietCtx());
	const cmd = plan.steps.map((s) => [...Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${quote(v)}`), show(s.argv)].join(" ")).join(" && ");
	const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(cmd)}\nend tell`;
	const r = await run(["/usr/bin/osascript", "-e", script], { env: baseEnv(), timeoutMs: 15_000 });
	if (r.code !== 0) throw new Error(r.err.trim() || "Terminal didn't open");
	engine.record({ event: "started", item: it.id, name: it.name, text: `Handed to Terminal: ${cmd}`, tone: "info", by: "you" });
	it.state.nextAt = Date.now() + 10 * 60_000;
}

function setItemField(it: Item, field: string, value: string | boolean) {
	if (field === "policy") engine.update(it.id, { policy: value as Policy }, `Policy: ${POLICY_LABEL[it.policy]} → ${POLICY_LABEL[value as Policy]}`);
	else if (field === "channel") {
		engine.update(it.id, { channel: value === "stable" ? undefined : String(value) }, `Channel → ${value}`);
		engine.enqueue("check", it, "you");
	} else if (field === "interval") engine.update(it.id, { intervalHours: value === "default" ? undefined : Number(value) }, `Check interval → ${value === "default" ? "default" : `${value} h`}`);
	else if (field === "pinned") engine.update(it.id, { pinned: !!value }, value ? `Pinned at ${it.state.installed}` : "Unpinned");
}

function setSetting(field: string, value: string | boolean) {
	const patch: Partial<Settings> = {};
	if (field === "intervalHours") patch.intervalHours = Number(value);
	else if (field === "autoUpdates" || field === "acOnly" || field === "useGh") patch[field] = !!value;
	else if (field === "window") patch.window = value as Settings["window"];
	else if (field === "folders") patch.folders = String(value);
	engine.setSettings(patch);
}

ctx = definePlugin({
	prepare: () => engine.prepareShutdown(),
	stop: () => {
		engine.stop();
		if (pending) clearTimeout(pending);
	},
	async start(c) {
		ctx = c;
		// Login startup files can have external side effects; skip them during staging.
		if (process.env.TOOLBELT_LIFECYCLE_MODE !== "probe") await initPath();
		engine.start();
		c.badge(engine.updates().length || null);
	},
	onOpen: (surface) => void open.add(surface),
	onClose: (surface) => void open.delete(surface),
	render: {
		"screen:monitored": () => monitored(engine, SCREEN.updates),
		"screen:discover": () => discover(engine, SCREEN.discover),
		"screen:activity": () => activity(engine, SCREEN.activity),
		"screen:settings": () => settingsScreen(engine, SCREEN.settings),
		quick: () => quick(engine),
	},
	async onEvent(surface, name, payload, c) {
		if (process.env.TOOLBELT_LIFECYCLE_MODE === "probe") return;
		const rowId: string | undefined = payload?.rowId;
		const ids: string[] = payload?.rowIds ?? [];
		const it = rowId ? engine.item(rowId) : undefined;
		const run = rowId ? engine.getRun(rowId) : undefined;
		try {
			if (UPDATE_IDS.has(name)) {
				// One click from a row or the quick view: the row and a card show the progress.
				if (it) updateMany([it], surface);
				return;
			}
			switch (name) {
				case "search":
					ui.query[surface] = String(payload?.query ?? "");
					break;
				case "filter":
					ui.filters[surface] = { ...ui.filters[surface], [String(payload?.filter)]: (payload?.values ?? []).map(String) };
					break;
				// Updates
				case "check":
					if (it) engine.enqueue("check", it, "you", undefined, undefined, surface);
					break;
				case "check-many":
					engine.batch("check", ids.map((id) => engine.item(id)).filter((i): i is Item => !!i), "you", `Check ${ids.length} items`, surface);
					break;
				case "check-all":
					engine.batch("check", engine.items, "you", "Check all", surface);
					break;
				case "update-safe": {
					if (ui.dialog?.kind === "bulk") ui.dialog = null;
					const safe = engine.updates().filter(bulkUpdatable);
					updateMany(safe, surface, `Update ${safe.length} ready`);
					break;
				}
				case "update-many": {
					const chosen = ids.map((id) => engine.item(id)).filter((i): i is Item => !!i && hasUpdate(i));
					const safe = chosen.filter(bulkUpdatable);
					updateMany(safe, surface);
					const left = chosen.length - safe.length;
					if (left) c.toast(`${left} of the selected need${left === 1 ? "s" : ""} individual review (app, major version, password or own command): use their Update button.`);
					else if (!chosen.length) c.toast("None of the selected has an update.");
					break;
				}
				case "review-safe":
					if (surface === "quick") {
						ui.dialog = { surface: SCREEN.updates, kind: "bulk" };
						c.navigate("monitored");
					} else ui.dialog = { surface, kind: "bulk" };
					break;
				case "review":
				case "notes":
					if (!it) break;
					if (surface === "quick") {
						c.navigate("monitored", { select: it.id });
						await openReview(SCREEN.updates, it);
					} else await openReview(surface, it);
					break;
				case "settings":
					if (it) ui.dialog = { surface, kind: "settings", itemId: it.id };
					break;
				case "history":
					if (it) ui.dialog = { surface, kind: "history", itemId: it.id };
					break;
				case "skip":
					if (ui.dialog?.kind === "review") {
						const r = engine.item(ui.dialog.review.itemId);
						ui.dialog = null;
						if (r) engine.update(r.id, { skip: r.state.latest }, `Skipped version ${r.state.latest}`);
					} else if (it) engine.update(it.id, { skip: it.state.latest }, `Skipped version ${it.state.latest}`);
					break;
				case "pin":
				case "unpin":
					if (it) setItemField(it, "pinned", name === "pin");
					break;
				case "rollback":
					if (it) engine.enqueue("rollback", it, "you", undefined, undefined, surface);
					break;
				case "remove":
					if (it) engine.remove(it.id);
					break;
				case "remove-many":
					for (const id of ids) engine.remove(id);
					break;
				case "update-now": {
					// From the review dialog: it stays open and follows the update.
					if (ui.dialog?.kind !== "review") break;
					const review = ui.dialog.review;
					const r = engine.item(review.itemId);
					if (!r || !r.state.outdated) break;
					const job = engine.enqueue("update", r, "you", r.state.latest, undefined, ui.dialog.surface);
					if (job) review.jobId = job.id;
					break;
				}
				case "cancel-dialog-job": {
					const d = ui.dialog;
					const job = d?.kind === "review" ? d.review.jobId : d?.kind === "log" ? d.jobId : undefined;
					if (job) engine.cancel(job);
					break;
				}
				case "terminal": {
					if (ui.dialog?.kind !== "review") break;
					const r = engine.item(ui.dialog.review.itemId);
					ui.dialog = null;
					if (r) await runInTerminal(r);
					break;
				}
				// Discover
				case "scan":
					engine.enqueue("scan", null, "you", undefined, undefined, surface);
					break;
				case "monitor":
				case "monitor-many":
				case "monitor-new": {
					const want = name === "monitor" ? [rowId!] : name === "monitor-many" ? ids : (engine.discovered?.diff?.added ?? []);
					const cands = (engine.discovered?.candidates ?? []).filter((x) => want.includes(x.id));
					const added = engine.add(cands);
					if (added.length) c.toast(`Watching ${added.length} more; checking ${added.length === 1 ? "it" : "them"} now`, "success");
					break;
				}
				// Runs (cards) and jobs
				case "run-cancel":
					if (run) engine.cancelRun(run.id);
					break;
				case "run-dismiss":
					if (run) run.dismissed = true;
					break;
				case "run-activity":
					if (run) c.navigate("activity", run.jobs.length > 1 && run.endedAt ? { select: runRowId(run.id) } : undefined);
					break;
				case "run-discover":
					if (run) run.dismissed = true;
					c.navigate("discover");
					break;
				case "show-run": {
					const r = engine.getRun(String(payload?.run ?? ""));
					if (r) {
						const t = runTarget(r);
						c.navigate(t.screen, t.select ? { select: t.select } : undefined);
					}
					break;
				}
				case "cancel":
					if (rowId) engine.cancel(rowId);
					break;
				case "log": {
					// Job ids, or Activity rows that end with "|<job id>".
					const job = rowId?.includes("|") ? rowId.split("|").pop() : rowId;
					if (job) ui.dialog = { surface: surface === "quick" ? SCREEN.activity : surface, kind: "log", jobId: job };
					break;
				}
				// Settings and dialogs
				case "add-recipe":
					ui.dialog = { surface, kind: "recipe", draft: { name: "", version: "", latest: "", update: "", repo: "" } };
					break;
				case "recipe-save": {
					if (ui.dialog?.kind !== "recipe") break;
					const d = ui.dialog.draft;
					const cand = customCandidate({ name: d.name.trim(), version: d.version.trim(), latest: d.latest.trim(), update: d.update.trim(), repo: d.repo.trim() || undefined });
					if (engine.item(cand.id)) throw new Error(`There's already a recipe called ${d.name}`);
					ui.dialog = null;
					engine.add([cand], { reviewed: recipeHash(cand.data) });
					engine.record({ event: "changed", item: cand.id, name: cand.name, text: `Reviewed commands: ${cand.data.version} | ${cand.data.latest} | ${cand.data.update}`, tone: "warning", by: "you" });
					break;
				}
				case "field": {
					const { form, field, value } = payload ?? {};
					if (form === "settings") setSetting(field, value);
					else if (form === "item" && ui.dialog?.kind === "settings") {
						const target = engine.item(ui.dialog.itemId);
						if (target) setItemField(target, field, value);
					} else if (form === "recipe" && ui.dialog?.kind === "recipe") (ui.dialog.draft as Record<string, string>)[field] = String(value);
					break;
				}
				case "dialog-close":
				case "dialog-done":
					ui.dialog = null;
					break;
			}
		} catch (e) {
			c.toast((e as Error).message, "error");
		} finally {
			c.invalidate();
		}
	},
});
