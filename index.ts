// Upkeep: keeps what you choose up to date. See docs/upkeep.md.
//
// Nothing is checked or changed until you choose: a fresh install watches nothing, scanning
// only reads, and updates are "notify only" until you turn automatic updates on (globally and
// per item). Everything is recorded in the audit log (Activity).
import { dataDir, definePlugin, type Context } from "./sdk";
import { Engine, hasUpdate } from "./lib/engine";
import { initPath, quote, run, show, baseEnv } from "./lib/exec";
import { Store, type Settings } from "./lib/store";
import { POLICY_LABEL, type Item, type Policy } from "./lib/types";
import { customCandidate, recipeHash } from "./providers/custom";
import { provider } from "./providers";
import { activity, bindEngine, discover, monitored, queue, quick, settingsScreen, ui, type Review } from "./ui";

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
	async start(c) {
		ctx = c;
		await initPath();
		engine.start();
		c.badge(engine.updates().length || null);
	},
	render: {
		"screen:monitored": () => monitored(engine, "screen:monitored"),
		"screen:discover": () => discover(engine, "screen:discover"),
		"screen:queue": () => queue(engine, "screen:queue"),
		"screen:activity": () => activity(engine, "screen:activity"),
		"screen:settings": () => settingsScreen(engine, "screen:settings"),
		quick: () => quick(engine),
	},
	async onEvent(surface, name, payload, c) {
		const rowId: string | undefined = payload?.rowId;
		const ids: string[] = payload?.rowIds ?? [];
		const it = rowId ? engine.item(rowId) : undefined;
		try {
			switch (name) {
				case "search":
					ui.query[surface] = String(payload?.query ?? "");
					break;
				// Monitored
				case "check":
					if (it) engine.enqueue("check", it, "you");
					break;
				case "check-many":
					for (const id of ids) engine.item(id) && engine.enqueue("check", engine.item(id)!, "you");
					break;
				case "check-all":
					for (const i of engine.items) engine.enqueue("check", i, "you");
					break;
				case "update-safe":
					for (const i of engine.updates()) if (!i.state.blocked && !i.state.needsAuth && !["sparkle", "go", "custom"].includes(i.provider)) engine.enqueue("update", i, "you", i.state.latest);
					c.toast("Queued; see Queue for progress");
					break;
				case "review":
				case "notes":
					if (it) await openReview(surface, it);
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
					if (it) engine.enqueue("rollback", it, "you");
					break;
				case "remove":
					if (it) engine.remove(it.id);
					break;
				case "remove-many":
					for (const id of ids) engine.remove(id);
					break;
				case "update": {
					if (ui.dialog?.kind !== "review") break;
					const r = engine.item(ui.dialog.review.itemId);
					ui.dialog = null;
					if (r && hasUpdate(r) === false && !r.state.outdated) break;
					if (r) {
						engine.enqueue("update", r, "you", r.state.latest);
						c.toast(`Updating ${r.name}; see Queue`);
					}
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
					engine.enqueue("scan", null, "you");
					break;
				case "monitor":
				case "monitor-many": {
					const want = name === "monitor" ? [rowId!] : ids;
					const cands = (engine.discovered?.candidates ?? []).filter((x) => want.includes(x.id));
					const added = engine.add(cands);
					c.toast(`Watching ${added.length} more; checking them now`, "success");
					break;
				}
				// Queue / Activity
				case "cancel":
					if (rowId) engine.cancel(rowId);
					break;
				case "log": {
					// Queue rows are job ids; Activity rows end with "|<job id>".
					const job = rowId?.includes("|") ? rowId.split("|").pop() : rowId;
					if (job) ui.dialog = { surface, kind: "log", jobId: job };
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
		}
		c.invalidate();
	},
});
