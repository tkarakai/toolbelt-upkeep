// Upkeep's plugin definition: the SDK's lifecycle, surfaces and events wired to the Store and
// Engine. `index.ts` runs it; tests run it under the SDK's fake host with a temporary data folder.
//
// Events come from the person (`origin: "person"`, every person's screen shares the PERSON
// instance) or from an agent acting for them in an instance of its own (`origin: "agent"`).
// Both are handled alike: same checks, and dialogs belong to the instance that opened them. An
// agent's changes are recorded as "An agent", and a recipe an agent adds is never marked reviewed.
import { PERSON, type Context, type EventInfo, type EventResult, type PluginDefinition } from "@toolbelt/sdk";
import { Engine, bulkUpdatable, hasUpdate, type By, type Job, type Run } from "./lib/engine";
import { initPath, quote, run, show, baseEnv } from "./lib/exec";
import { Store, type Settings } from "./lib/store";
import { POLICY_LABEL, type Item, type Policy } from "./lib/types";
import { customCandidate, recipeHash } from "./providers/custom";
import { provider } from "./providers";
import { ACTIONS, activity, discover, FORMS, monitored, offeredUpdate, quick, runRowId, SCREEN, settingsScreen, UPDATE_IDS, VIEWS, visibleRuns, type Dialogs, type OpenDialog, type Review } from "./ui";

const probing = () => process.env.TOOLBELT_LIFECYCLE_MODE === "probe";

/** What a started run or job is, for whoever started it (an agent reads these ids). */
function started(r: Run | null): EventResult {
	if (!r) return { data: { run: null, reason: "Nothing started: it's already queued or running, or Upkeep is stopping" } };
	return { data: { run: r.id, jobs: [...r.jobs] } };
}
const startedJob = (j: Job | null): EventResult => (j ? { data: { run: j.run, job: j.id } } : started(null));

export function createUpkeep(dir: string) {
	const store = new Store(dir);
	let ctx: Context | undefined;

	// Output can arrive many lines a second: redraw at most every 250 ms.
	let pending: ReturnType<typeof setTimeout> | null = null;
	const changed = () => {
		if (pending) return;
		pending = setTimeout(() => {
			pending = null;
			ctx?.invalidate();
			ctx?.badge(engine.updates().length || null);
		}, 250);
	};

	const engine = new Engine(store, changed);
	const dialogs: Dialogs = new Map();

	// Surfaces the person has open: a finished run whose card they're looking at needs no toast.
	// An agent's instance doesn't count: the toast is how the person learns of it.
	const personOpen = new Set<string>();
	const screenOf = (surface: string) => surface.replace(/^screen:/, "");

	/** Where a run's outcome is best seen by the person. */
	function runTarget(r: Run): { screen: string; select?: string } {
		if (r.surface && r.surface.startsWith("screen:") && visibleRuns(engine, r.surface, PERSON).includes(r)) return { screen: screenOf(r.surface) };
		if (r.jobs.length > 1) return { screen: "activity", select: runRowId(r.id) };
		const job = engine.jobsOf(r)[0];
		if (r.kind === "scan") return { screen: "discover" };
		return { screen: "monitored", select: job?.itemId };
	}

	engine.onRunDone = (r) => {
		if (!ctx) return;
		if (r.by === "schedule") return; // quiet: the badge and the list say what's new
		if (r.surface && personOpen.has(r.surface) && visibleRuns(engine, r.surface, PERSON).includes(r)) return;
		const mine = dialogs.get(PERSON);
		if (mine?.kind === "review" && mine.review.jobId && r.jobs.includes(mine.review.jobId)) return;
		const tone = r.summary?.tone === "danger" ? "error" : r.summary?.tone === "success" ? "success" : "default";
		const who = r.by === "auto" ? "Automatic: " : r.by === "agent" ? "Agent: " : "";
		ctx.toast(`${who}${r.title}: ${r.summary?.text ?? "finished"}`, tone, { id: "show-run", label: "Show", payload: { run: r.id } });
	};

	/** Start updates as one run, shown where they were started. */
	function updateMany(items: Item[], surface: string, by: By, title?: string) {
		const list = items.filter((i) => hasUpdate(i) && !i.state.blocked);
		if (!list.length) return null;
		const where = surface === "quick" ? SCREEN.updates : surface;
		return engine.batch("update", list, by, title ?? (list.length === 1 ? `Update ${list[0].name}` : `Update ${list.length} items`), where, (i) => i.state.latest);
	}

	// ── review: plan + every release note between installed and newest ──────
	/** Opens the review dialog at once and fills it in as the plan and notes arrive. */
	function openReview(instance: string, surface: string, it: Item) {
		const review: Review = { itemId: it.id, target: it.state.latest, loading: true };
		dialogs.set(instance, { surface, kind: "review", review });
		void (async () => {
			const p = provider(it.provider)!;
			const q = engine.quietCtx();
			const s = it.state;
			if (s.outdated && s.latest) review.plan = await engine.plan(it, s.latest, q).catch((e) => ((review.error = (e as Error).message), undefined));
			try {
				if (p.notes && s.installed) {
					// Up to date: the notes of the version you have (and a few before it).
					review.notes = s.outdated && s.latest ? await p.notes(it, s.installed, s.latest, q) : (await p.notes(it, "0", s.installed, q)).slice(0, 5);
				} else review.notes = [];
			} catch (e) {
				review.notesError = (e as Error).message;
			}
			review.loading = false;
			ctx?.invalidate();
		})();
	}

	/** Hand an update to Terminal: the person sees the command and types the password there if asked. */
	async function runInTerminal(it: Item) {
		const plan = await engine.plan(it, it.state.latest!, engine.quietCtx());
		const cmd = plan.steps.map((s) => [...Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${quote(v)}`), show(s.argv)].join(" ")).join(" && ");
		const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(cmd)}\nend tell`;
		const r = await run(["/usr/bin/osascript", "-e", script], { env: baseEnv(), timeoutMs: 8_000 });
		if (r.code !== 0) throw new Error(r.err.trim() || "Terminal didn't open");
		engine.record({ event: "started", item: it.id, name: it.name, text: `Handed to Terminal: ${cmd}`, tone: "info", by: "you" });
		it.state.nextAt = Date.now() + 10 * 60_000;
	}

	function setItemField(it: Item, field: string, value: unknown, by: By) {
		if (field === "policy") engine.update(it.id, { policy: value as Policy }, `Policy: ${POLICY_LABEL[it.policy]} → ${POLICY_LABEL[value as Policy]}`, by);
		else if (field === "channel") {
			engine.update(it.id, { channel: value === "stable" ? undefined : String(value) }, `Channel → ${value}`, by);
			engine.enqueue("check", it, by);
		} else if (field === "interval") engine.update(it.id, { intervalHours: value === "default" ? undefined : Number(value) }, `Check interval → ${value === "default" ? "default" : `${value} h`}`, by);
		else if (field === "pinned") engine.update(it.id, { pinned: !!value }, value ? `Pinned at ${it.state.installed}` : "Unpinned", by);
	}

	/** The Settings form. Automatic updates aren't a field: they're switched on by a confirmed action. */
	function setSetting(field: string, value: unknown, by: By) {
		const patch: Partial<Settings> = {};
		if (field === "intervalHours") patch.intervalHours = Number(value);
		else if (field === "acOnly" || field === "useGh") patch[field] = !!value;
		else if (field === "window") patch.window = value as Settings["window"];
		else if (field === "folders") patch.folders = String(value);
		else return false;
		engine.setSettings(patch, by);
	}

	async function handle(surface: string, name: string, payload: any, c: Context, event: EventInfo): Promise<EventResult> {
		const { instance } = event;
		const by: By = event.origin === "agent" ? "agent" : "you";
		const rowId: string | undefined = payload?.rowId;
		const ids: string[] = payload?.rowIds ?? [];
		const it = rowId ? engine.item(rowId) : undefined;
		const runOfRow = rowId ? engine.getRun(rowId) : undefined;
		const dialog = dialogs.get(instance);
		const open = (d: OpenDialog) => void dialogs.set(instance, d);
		const close = () => void dialogs.delete(instance);

		if (UPDATE_IDS.has(name)) {
			// One click from a row or the quick view: the row and a card show the progress. The
			// action id carries the confirmation the person (or the approval) saw: it must still be
			// the one this item offers.
			if (!it) throw new Error("That item isn't watched any more");
			const offered = offeredUpdate(engine, it);
			if (!offered) throw new Error(`${it.name} has no update to start now`);
			if (offered !== name) throw new Error(`${it.name} now offers a different update (${offered}, not ${name}): look at it again before updating`);
			return started(updateMany([it], surface, by));
		}
		switch (name) {
			// Updates
			case "check":
				if (!it) return false;
				return startedJob(engine.enqueue("check", it, by, undefined, undefined, surface));
			case "check-many":
				return started(engine.batch("check", ids.map((id) => engine.item(id)).filter((i): i is Item => !!i), by, `Check ${ids.length} items`, surface));
			case "check-all":
				return started(engine.batch("check", engine.items, by, "Check all", surface));
			case "update-safe": {
				if (dialog?.kind === "bulk") close();
				const safe = engine.updates().filter(bulkUpdatable);
				return started(updateMany(safe, surface, by, `Update ${safe.length} ready`));
			}
			case "update-many": {
				const chosen = ids.map((id) => engine.item(id)).filter((i): i is Item => !!i && hasUpdate(i));
				const safe = chosen.filter(bulkUpdatable);
				const r = updateMany(safe, surface, by);
				const left = chosen.filter((i) => !bulkUpdatable(i));
				if (left.length) c.toast(`${left.length} of the selected need${left.length === 1 ? "s" : ""} individual review (app, major version, password or own command): use their Update button.`);
				else if (!chosen.length) c.toast("None of the selected has an update.");
				return { data: { run: r?.id ?? null, jobs: r ? [...r.jobs] : [], notIncluded: left.map((i) => i.id) } };
			}
			case "review-safe":
				if (surface === "quick") {
					dialogs.set(PERSON, { surface: SCREEN.updates, kind: "bulk" });
					c.navigate("monitored");
				} else open({ surface, kind: "bulk" });
				return;
			case "review":
			case "notes":
				if (!it) return false;
				if (surface === "quick") {
					c.navigate("monitored", { select: it.id });
					openReview(PERSON, SCREEN.updates, it);
				} else openReview(instance, surface, it);
				return;
			case "settings":
				if (!it) return false;
				open({ surface, kind: "settings", itemId: it.id });
				return;
			case "history":
				if (!it) return false;
				open({ surface, kind: "history", itemId: it.id });
				return;
			case "skip": {
				const target = dialog?.kind === "review" ? engine.item(dialog.review.itemId) : it;
				if (dialog?.kind === "review") close();
				if (!target) return false;
				engine.update(target.id, { skip: target.state.latest }, `Skipped version ${target.state.latest}`, by);
				return;
			}
			case "pin":
			case "unpin":
				if (!it) return false;
				setItemField(it, "pinned", name === "pin", by);
				return;
			case "rollback":
				if (!it) return false;
				return startedJob(engine.enqueue("rollback", it, by, undefined, undefined, surface));
			case "remove":
				if (!it) return false;
				engine.remove(it.id, by);
				return;
			case "remove-many":
				for (const id of ids) engine.remove(id, by);
				return;
			case "update-now": {
				// From the review dialog: it stays open and follows the update.
				if (dialog?.kind !== "review") return false;
				const r = engine.item(dialog.review.itemId);
				if (!r || !r.state.outdated) throw new Error("There's no update to start now");
				const job = engine.enqueue("update", r, by, r.state.latest, undefined, dialog.surface);
				if (job) dialog.review.jobId = job.id;
				return startedJob(job);
			}
			case "cancel-dialog-job": {
				const job = dialog?.kind === "review" ? dialog.review.jobId : dialog?.kind === "log" ? dialog.jobId : undefined;
				if (!job) return false;
				engine.cancel(job);
				return { data: { job } };
			}
			case "terminal": {
				if (dialog?.kind !== "review" || event.origin !== "person") return false;
				const r = engine.item(dialog.review.itemId);
				close();
				if (r) await runInTerminal(r);
				return;
			}
			// Discover
			case "scan":
				return startedJob(engine.enqueue("scan", null, by, undefined, undefined, surface));
			case "monitor":
			case "monitor-many":
			case "monitor-new": {
				const want = name === "monitor" ? (rowId ? [rowId] : []) : name === "monitor-many" ? ids : (engine.discovered?.diff?.added ?? []);
				const cands = (engine.discovered?.candidates ?? []).filter((x) => want.includes(x.id));
				const added = engine.add(cands, {}, by);
				if (added.length) c.toast(`Watching ${added.length} more; checking ${added.length === 1 ? "it" : "them"} now`, "success");
				const check = added.length ? engine.jobs.find((j) => j.itemId === added[0].id && j.type === "check") : undefined;
				return { data: { watching: added.map((i) => i.id), run: check?.run ?? null } };
			}
			// Runs (cards) and jobs
			case "run-cancel":
				if (!runOfRow) return false;
				engine.cancelRun(runOfRow.id);
				return { data: { run: runOfRow.id } };
			case "run-dismiss":
				if (!runOfRow) return false;
				runOfRow.dismissedIn = [...(runOfRow.dismissedIn ?? []), instance];
				return;
			case "run-activity":
				if (!runOfRow) return false;
				c.navigate("activity", runOfRow.jobs.length > 1 && runOfRow.endedAt ? { select: runRowId(runOfRow.id) } : undefined);
				return;
			case "run-discover":
				if (runOfRow) runOfRow.dismissedIn = [...(runOfRow.dismissedIn ?? []), instance];
				c.navigate("discover");
				return;
			case "show-run": {
				const r = engine.getRun(String(payload?.run ?? ""));
				if (!r) return false;
				const t = runTarget(r);
				c.navigate(t.screen, t.select ? { select: t.select } : undefined);
				return;
			}
			case "cancel":
				if (!rowId) return false;
				engine.cancel(rowId);
				return { data: { job: rowId } };
			case "log": {
				// Job ids, or Activity rows that end with "|<job id>".
				const job = rowId?.includes("|") ? rowId.split("|").pop() : rowId;
				if (!job) return false;
				if (surface === "quick") dialogs.set(PERSON, { surface: SCREEN.activity, kind: "log", jobId: job });
				else open({ surface, kind: "log", jobId: job });
				return;
			}
			// Settings and dialogs
			case "add-recipe":
				open({ surface, kind: "recipe", draft: { name: "", version: "", latest: "", update: "", repo: "" } });
				return;
			case "recipe-save": {
				if (dialog?.kind !== "recipe") return false;
				const d = dialog.draft;
				const cand = customCandidate({ name: d.name.trim(), version: d.version.trim(), latest: d.latest.trim(), update: d.update.trim(), repo: d.repo.trim() || undefined });
				if (!cand.data.version || !cand.data.latest || !cand.data.update || !d.name.trim()) throw new Error("A recipe needs a name and all three commands");
				if (engine.item(cand.id)) throw new Error(`There's already a recipe called ${d.name}`);
				close();
				// Saving is the person's review of these exact commands, but only when the person saves.
				// An agent's recipe waits for the person to review it in Upkeep before anything runs.
				const reviewed = event.origin === "person";
				engine.add([cand], reviewed ? { reviewed: recipeHash(cand.data) } : {}, by);
				if (reviewed) engine.record({ event: "changed", item: cand.id, name: cand.name, text: `Reviewed commands: ${cand.data.version} | ${cand.data.latest} | ${cand.data.update}`, tone: "warning", by });
				else engine.record({ event: "changed", item: cand.id, name: cand.name, text: `Added by ${event.agent ?? "an agent"}, not reviewed: nothing runs until you review its commands`, tone: "warning", by });
				return { data: { item: cand.id, reviewed } };
			}
			case "review-recipe":
				if (!it || it.provider !== "custom" || event.origin !== "person") return false;
				open({ surface, kind: "recipe-review", itemId: it.id });
				return;
			case "recipe-approve": {
				// The person's review only: agents never see this action, and it's refused if one sends it.
				if (dialog?.kind !== "recipe-review" || event.origin !== "person") return false;
				const r = engine.item(dialog.itemId);
				close();
				if (!r) return false;
				engine.update(r.id, { reviewed: recipeHash(r.data) }, `Reviewed commands: ${r.data.version} | ${r.data.latest} | ${r.data.update}`, "you");
				return startedJob(engine.enqueue("check", r, "you", undefined, undefined, surface));
			}
			case "auto-updates-on":
			case "auto-updates-off":
				engine.setSettings({ autoUpdates: name === "auto-updates-on" }, by);
				return;
			case "field": {
				const { form, field, value } = payload ?? {};
				if (form === "settings") return setSetting(field, value, by);
				if (form === "item" && dialog?.kind === "settings") {
					const target = engine.item(dialog.itemId);
					if (!target) return false;
					setItemField(target, field, value, by);
					return;
				}
				if (form === "recipe" && dialog?.kind === "recipe" && field in dialog.draft) {
					(dialog.draft as Record<string, string>)[field] = String(value);
					return;
				}
				return false;
			}
			case "dialog-close":
			case "dialog-done":
				close();
				return;
		}
		return false;
	}

	const definition: PluginDefinition = {
		prepare: () => engine.prepareShutdown(),
		stop: () => {
			engine.stop();
			if (pending) clearTimeout(pending);
		},
		async start(c) {
			ctx = c;
			// Login startup files can have external side effects; skip them during staging.
			if (!probing()) await initPath();
			engine.start();
			c.badge(engine.updates().length || null);
		},
		onOpen: (surface, _c, { origin }) => {
			if (origin === "person") personOpen.add(surface);
		},
		onClose: (surface, _c, { instance, origin }) => {
			if (origin === "person") personOpen.delete(surface);
			// An agent's instance takes its dialog (and draft) with it; the person's stays open
			// for when they come back to the screen.
			else if (dialogs.get(instance)?.surface === surface) dialogs.delete(instance);
		},
		// Search and filters: the SDK applies their events, the host saves the person's.
		views: VIEWS,
		actions: ACTIONS,
		forms: FORMS,
		render: {
			"screen:monitored": (_c, view) => monitored(engine, SCREEN.updates, view, dialogs),
			"screen:discover": (_c, view) => discover(engine, SCREEN.discover, view, dialogs),
			"screen:activity": (_c, view) => activity(engine, SCREEN.activity, view, dialogs),
			"screen:settings": (_c, view) => settingsScreen(engine, SCREEN.settings, view, dialogs),
			quick: () => quick(engine),
		},
		async onEvent(surface, name, payload, c, event) {
			if (probing()) return false;
			try {
				return await handle(surface, name, payload, c, event);
			} catch (e) {
				// The result carries the error; the person also sees it where they acted.
				if (event.origin === "person") c.toast((e as Error).message, "error");
				throw e;
			} finally {
				c.invalidate();
			}
		},
	};
	return { definition, engine, dialogs, store };
}
