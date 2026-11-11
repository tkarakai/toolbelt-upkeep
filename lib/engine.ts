// The engine: items, the job queue, the schedule, and the check / update / rollback flows with
// their safety rules. The UI (ui.ts) only reads its state and calls its methods.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askedForPassword, baseEnv, output, run, show } from "./exec";
import { Store, type AuditEntry, type Settings, type Tone } from "./store";
import { change, compare, policyAllows, type Change } from "./version";
import type { Candidate, Check, Ctx, Item, Plan, Step } from "./types";
import { PROVIDERS, provider } from "../providers";
import { setProviderSettings } from "../providers/shared";
import { gitPrecheck } from "../providers/git";
import { recipeHash } from "../providers/custom";

export type By = "you" | "schedule" | "auto";
export type JobType = "scan" | "check" | "update" | "rollback";
export type LogLine = { text: string; at?: number; tone?: Tone };
export type Job = {
	id: string;
	type: JobType;
	itemId?: string;
	title: string;
	by: By;
	state: "queued" | "running" | "done" | "failed" | "cancelled";
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	lines: LogLine[];
	result?: string;
	tone?: Tone;
	group: string;
	target?: string;
	abort: AbortController;
};

const MAX_RUNNING = 3;
const MAX_LINES = 1500;
const UA = "Toolbelt-Upkeep/0.1 (+https://github.com/tkarakai/toolbelt)";
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Not before `at`, with ±5 % jitter so items don't all check at once. */
export const jitter = (ms: number, rnd = Math.random()) => Math.round(ms * (0.95 + rnd * 0.1));

/** When to try again after `failures` failed checks: 15 min, 30, 1 h… up to the interval. */
export const backoff = (failures: number, interval: number) => Math.min(interval, 15 * MIN * 2 ** Math.max(0, failures - 1));

/** The size of the step an item would take (git clones: a "minor" step, they have no versions). */
export function stepOf(item: Item): Change {
	const { installed, latest, outdated } = item.state;
	if (!outdated || !installed || !latest) return "none";
	if (item.provider === "git") return "minor";
	const c = change(installed, latest);
	return c === "none" ? "patch" : c; // the provider says outdated even if the versions don't order
}

/** Does this item count as "has an update" (not pinned, not the skipped version)? */
export const hasUpdate = (item: Item) => item.state.outdated && !item.pinned && !(item.skip && item.state.latest === item.skip);

/** Bulk updates never cross a major version or quit an app without its individual review. */
export const bulkUpdatable = (item: Item) => hasUpdate(item) && !item.state.blocked && !item.state.needsAuth && !item.data.auth && item.kind !== "app" && stepOf(item) !== "major" && !["sparkle", "go", "custom"].includes(item.provider);

/**
 * Why an automatic update may not run for this item now — or null when it may. The plan-level
 * rules (password, running app, handoff, unverified) are checked again with the plan.
 */
export function autoBlocker(item: Item, s: Settings, env: { onAC: boolean; hour: number }): string | null {
	if (!s.autoUpdates) return "automatic updates are off";
	if (item.policy === "notify") return "notify only";
	if (!hasUpdate(item)) return "no update";
	if (item.state.blocked) return item.state.blocked;
	if (item.state.needsAuth) return "needs your password";
	if (["custom", "sparkle", "go"].includes(item.provider)) return "this kind is never updated automatically";
	const step = stepOf(item);
	if (!policyAllows(item.policy, step)) return `a ${step} update is beyond the item's policy`;
	if (s.acOnly && !env.onAC) return "on battery";
	if (s.window === "night" && !(env.hour >= 1 && env.hour < 6)) return "outside 1:00–6:00";
	return null;
}

export function planBlocker(plan: Plan): string | null {
	if (plan.needsAuth) return "needs your password";
	if (plan.handoff) return "updates in its own app";
	if (plan.unverified) return "unverified command";
	return null;
}

export class Engine {
	items: Item[];
	settings: Settings;
	discovered: { at: number; candidates: Candidate[]; errors: Record<string, string> } | null;
	jobs: Job[] = [];
	audit: AuditEntry[];
	private seq = 0;
	private timer?: ReturnType<typeof setInterval>;
	private initialTick?: ReturnType<typeof setTimeout>;
	private quiescing = false;
	readonly askpass: string;

	constructor(
		readonly store: Store,
		private readonly changed: () => void,
	) {
		this.items = store.items();
		this.settings = store.settings();
		this.discovered = store.discovered();
		this.audit = store.recentAudit();
		setProviderSettings(this.settings);
		// Jobs don't survive a restart; nothing is half-done in the files.
		this.askpass = join(store.dir, "askpass.sh");
		writeFileSync(this.askpass, ASKPASS, { mode: 0o700 });
		chmodSync(this.askpass, 0o700);
	}

	start(mode: "active" | "probe" = process.env.TOOLBELT_LIFECYCLE_MODE === "probe" ? "probe" : "active") {
		this.stop();
		// A staged candidate must not poll or mutate external software before promotion.
		this.quiescing = mode === "probe";
		if (this.quiescing) return;
		this.timer = setInterval(() => this.tick(), 30_000);
		this.initialTick = setTimeout(() => this.tick(), 3000);
	}
	stop() {
		clearInterval(this.timer);
		clearTimeout(this.initialTick);
	}

	/** A package upgrade must never interrupt an external software change. */
	prepareShutdown(): { ready: boolean; reason?: string } {
		const active = this.active();
		if (active.length) return { ready: false, reason: `Upkeep has ${active.length} queued or running operation(s). Wait for Queue to finish, or cancel them explicitly.` };
		this.quiescing = true;
		this.stop();
		return { ready: true };
	}

	// ── persistence and audit ────────────────────────────────────────────
	private save() {
		this.store.saveItems(this.items);
	}

	record(e: Omit<AuditEntry, "at">) {
		const entry = { at: Date.now(), ...e };
		this.audit.push(entry);
		if (this.audit.length > 3000) this.audit.splice(0, this.audit.length - 2000);
		try {
			this.store.audit(entry);
		} catch (err) {
			console.error("upkeep: can't write the audit log:", err);
		}
	}

	setSettings(patch: Partial<Settings>) {
		const before = this.settings;
		this.settings = { ...this.settings, ...patch };
		this.store.saveSettings(this.settings);
		setProviderSettings(this.settings);
		for (const [k, v] of Object.entries(patch)) if ((before as Record<string, unknown>)[k] !== v) this.record({ event: "changed", text: `Setting ${k}: ${String((before as Record<string, unknown>)[k])} → ${String(v)}`, tone: "info", by: "you" });
		if ("intervalHours" in patch) for (const it of this.items) if (!it.intervalHours && it.state.checkedAt) it.state.nextAt = it.state.checkedAt + jitter(this.settings.intervalHours * HOUR);
		this.save();
		this.changed();
	}

	item = (id: string) => this.items.find((i) => i.id === id);
	interval = (it: Item) => (it.intervalHours ?? this.settings.intervalHours) * HOUR;
	/** Other items that are the same thing from another installer. */
	siblings = (it: Item | Candidate) => this.items.filter((o) => o.identity === it.identity && o.id !== it.id);

	// ── items ─────────────────────────────────────────────────────────────
	add(cands: Candidate[], extra: Partial<Item> = {}) {
		const added: Item[] = [];
		for (const c of cands) {
			if (this.item(c.id)) continue;
			const it: Item = { ...c, addedAt: Date.now(), policy: "notify", ...extra, state: { installed: c.installed, outdated: false, failures: 0, nextAt: Date.now() } };
			this.items.push(it);
			added.push(it);
			this.record({ event: "added", item: it.id, name: it.name, text: `Now watching ${it.name} (${provider(it.provider)?.label ?? it.provider})`, tone: "info", by: "you" });
		}
		this.save();
		for (const it of added) this.enqueue("check", it, "you");
		this.changed();
		return added;
	}

	remove(id: string) {
		const it = this.item(id);
		if (!it) return;
		for (const j of this.jobs) if (j.itemId === id && (j.state === "queued" || j.state === "running")) this.cancel(j.id);
		this.items = this.items.filter((i) => i.id !== id);
		this.record({ event: "removed", item: id, name: it.name, text: `Stopped watching ${it.name}`, tone: "muted", by: "you" });
		this.save();
		this.changed();
	}

	update(id: string, patch: Partial<Item>, what: string) {
		const it = this.item(id);
		if (!it) return;
		Object.assign(it, patch);
		this.record({ event: "changed", item: id, name: it.name, text: what, tone: "info", by: "you" });
		this.save();
		this.changed();
	}

	// ── jobs ──────────────────────────────────────────────────────────────
	enqueue(type: JobType, it: Item | null, by: By, target?: string): Job | null {
		if (this.quiescing) return null;
		if (it && this.jobs.some((j) => j.itemId === it.id && j.type === type && (j.state === "queued" || j.state === "running"))) return null;
		const p = it ? provider(it.provider) : undefined;
		const id = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${type}-${++this.seq}`;
		const verb = { scan: "Scan this Mac", check: "Check", update: "Update", rollback: "Roll back" }[type];
		const job: Job = { id, type, itemId: it?.id, title: it ? `${verb} ${it.name}` : verb, by, state: "queued", queuedAt: Date.now(), lines: [], group: type === "scan" ? "scan" : p?.serial ? p.id : (it?.id ?? id), target, abort: new AbortController() };
		this.jobs.push(job);
		const done = this.jobs.filter((j) => j.state !== "queued" && j.state !== "running");
		if (done.length > 60) this.jobs = this.jobs.filter((j) => !done.slice(0, done.length - 60).includes(j));
		this.changed();
		queueMicrotask(() => this.pump());
		return job;
	}

	cancel(jobId: string) {
		const j = this.jobs.find((x) => x.id === jobId);
		if (!j) return;
		if (j.state === "queued") this.finish(j, "cancelled", "Cancelled before it started", "muted");
		else if (j.state === "running") {
			this.log(j, "Cancelling…", "warning");
			j.abort.abort();
		}
	}

	private pump() {
		if (this.quiescing) return;
		const running = this.jobs.filter((j) => j.state === "running");
		for (const j of this.jobs) {
			if (running.length >= MAX_RUNNING) break;
			if (j.state !== "queued" || running.some((r) => r.group === j.group)) continue;
			j.state = "running";
			j.startedAt = Date.now();
			running.push(j);
			void this.execute(j);
		}
		this.changed();
	}

	private log(j: Job, text: string, tone?: Tone) {
		const line = { text, at: Date.now(), tone };
		j.lines.push(line);
		if (j.lines.length > MAX_LINES) j.lines.splice(0, j.lines.length - MAX_LINES);
		try {
			this.store.appendLog(j.id, `${new Date(line.at).toISOString()} ${text}`);
		} catch {}
		this.changed();
	}

	private finish(j: Job, state: Job["state"], result: string, tone: Tone) {
		j.state = state;
		j.result = result;
		j.tone = tone;
		j.endedAt = Date.now();
		this.log(j, result, tone === "danger" ? "danger" : tone === "success" ? "success" : "muted");
		queueMicrotask(() => this.pump());
	}

	/** What providers get: commands and fetches, logged to the job. */
	private ctx(j: Job, extraEnv: Record<string, string | undefined> = {}): Ctx {
		const verbose = j.type === "update" || j.type === "rollback";
		const env = baseEnv(extraEnv);
		const c: Ctx = {
			signal: j.abort.signal,
			run: (argv, opts = {}) => {
				this.log(j, `$ ${show(argv)}`, "info");
				return run(argv, { env: { ...env, ...opts.env }, signal: j.abort.signal, ...opts, onLine: verbose ? (l) => this.log(j, l.text, l.stream === "err" ? "muted" : undefined) : undefined });
			},
			output: (argv, opts = {}) => {
				this.log(j, `$ ${show(argv)}`, "info");
				return output(argv, { env: { ...env, ...opts.env }, signal: j.abort.signal, ...opts });
			},
			json: async (url, init) => JSON.parse(await this.fetchText(j, url, init?.headers)),
			text: (url) => this.fetchText(j, url),
			log: (text, tone) => this.log(j, text, tone === "warning" ? "warning" : tone === "danger" ? "danger" : tone === "success" ? "success" : "muted"),
		};
		return c;
	}

	private async fetchText(j: Job, url: string, headers: Record<string, string> = {}): Promise<string> {
		this.log(j, `GET ${url}`, "muted");
		const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.any([j.abort.signal, AbortSignal.timeout(30_000)]), redirect: "follow" });
		if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
		return res.text();
	}

	private async execute(j: Job) {
		try {
			if (j.type === "scan") await this.runScan(j);
			else {
				const it = this.item(j.itemId!);
				if (!it) return this.finish(j, "cancelled", "The item was removed", "muted");
				if (j.type === "check") await this.runCheck(j, it);
				else if (j.type === "update") await this.runUpdate(j, it);
				else await this.runRollback(j, it);
			}
		} catch (e) {
			const msg = (e as Error).message ?? String(e);
			const cancelled = j.abort.signal.aborted;
			if (cancelled) this.finish(j, "cancelled", "Cancelled", "muted");
			else this.finish(j, "failed", msg, "danger");
			// Checks record their own failures; updates, rollbacks and scans are recorded here.
			if (j.type !== "check") {
				const it = j.itemId ? this.item(j.itemId) : undefined;
				this.record({ event: cancelled ? "cancelled" : j.type === "scan" ? "scan" : j.type, item: it?.id, name: it?.name, text: cancelled ? `${j.title}: cancelled` : `${j.title} failed: ${msg}`, tone: cancelled ? "muted" : "danger", job: j.id, by: j.by });
			}
		}
		if (j.state === "running") this.finish(j, "done", j.result ?? "Done", j.tone ?? "success");
	}

	// ── scan ──────────────────────────────────────────────────────────────
	private async runScan(j: Job) {
		const ctx = this.ctx(j);
		const candidates: Candidate[] = [];
		const errors: Record<string, string> = {};
		await Promise.all(
			PROVIDERS.filter((p) => p.id !== "custom").map(async (p) => {
				try {
					if (!(await p.available())) return this.log(j, `${p.label}: not installed`, "muted");
					const found = await p.discover(ctx);
					candidates.push(...found);
					this.log(j, `${p.label}: ${found.length} found`);
				} catch (e) {
					errors[p.id] = (e as Error).message;
					this.log(j, `${p.label}: ${(e as Error).message}`, "danger");
				}
			}),
		);
		this.discovered = { at: Date.now(), candidates, errors };
		this.store.saveDiscovered(this.discovered);
		const n = Object.keys(errors).length;
		j.result = `Found ${candidates.length} things${n ? `; ${n} provider${n > 1 ? "s" : ""} failed` : ""}`;
		j.tone = n ? "warning" : "success";
		this.record({ event: "scan", text: j.result, tone: j.tone, job: j.id, by: j.by });
	}

	// ── check ─────────────────────────────────────────────────────────────
	private async runCheck(j: Job, it: Item) {
		const p = provider(it.provider);
		if (!p) throw new Error(`Unknown provider ${it.provider}`);
		const started = Date.now();
		let res: Check;
		try {
			res = await p.check(it, this.ctx(j));
		} catch (e) {
			if (j.abort.signal.aborted) throw e;
			it.state.failures++;
			it.state.error = (e as Error).message;
			it.state.checkedAt = Date.now();
			it.state.checkMs = Date.now() - started;
			it.state.nextAt = Date.now() + backoff(it.state.failures, this.interval(it));
			this.save();
			this.record({ event: "check", item: it.id, name: it.name, text: `Check failed: ${it.state.error}`, tone: "danger", job: j.id, by: j.by });
			throw e;
		}
		this.applyCheck(it, res, started);
		const s = it.state;
		const text = s.blocked && !s.latest ? s.blocked : hasUpdate(it) ? `Update available: ${s.installed} → ${s.latest}${s.blocked ? ` (${s.blocked})` : ""}` : s.outdated ? `${s.latest} available, ${it.pinned ? "pinned" : "skipped"}` : `Up to date (${s.installed ?? "?"})`;
		const tone: Tone = s.eol?.past ? "danger" : hasUpdate(it) ? "warning" : s.blocked ? "warning" : "success";
		j.result = text + (s.eol?.past ? " · end of life" : "");
		j.tone = tone;
		this.record({ event: "check", item: it.id, name: it.name, text: j.result, tone, job: j.id, by: j.by, detail: { installed: s.installed ?? "", latest: s.latest ?? "", took: `${s.checkMs} ms` } });
		// A scheduled check that found an update may start an automatic one.
		if (j.by === "schedule" && hasUpdate(it)) {
			const why = autoBlocker(it, this.settings, { onAC: await onAC(), hour: new Date().getHours() });
			if (!why) this.enqueue("update", it, "auto", s.latest);
		}
	}

	applyCheck(it: Item, res: Check, started = Date.now()) {
		const s = it.state;
		s.installed = res.installed ?? s.installed;
		s.latest = res.latest ?? s.latest;
		s.outdated = res.outdated ?? (!!s.installed && !!s.latest && compare(s.latest, s.installed) > 0);
		s.channel = res.channel;
		s.beyond = res.beyond;
		s.eol = res.eol;
		s.blocked = res.blocked;
		if (res.needsAuth) s.needsAuth = true;
		s.homepage = res.homepage ?? s.homepage;
		s.error = undefined;
		s.failures = 0;
		s.checkedAt = Date.now();
		s.checkMs = Date.now() - started;
		s.nextAt = Date.now() + jitter(this.interval(it));
		if (it.skip && s.latest && compare(s.latest, it.skip) > 0) it.skip = undefined; // a newer one: offer again
		this.save();
	}

	// ── update ────────────────────────────────────────────────────────────
	/** Prepare an update's plan (for the review dialog and the job itself). */
	async plan(it: Item, target: string, ctx?: Ctx): Promise<Plan> {
		const p = provider(it.provider)!;
		const plan = await p.plan(it, target, ctx ?? this.quietCtx());
		if (it.state.needsAuth) plan.needsAuth = true;
		return plan;
	}

	/** A context for work outside jobs (review dialog: plans and notes). */
	quietCtx(): Ctx {
		const env = baseEnv();
		return {
			run: (argv, opts = {}) => run(argv, { env, ...opts }),
			output: (argv, opts = {}) => output(argv, { env, ...opts }),
			json: async (url, init) => {
				const res = await fetch(url, { headers: { "User-Agent": UA, ...init?.headers }, signal: AbortSignal.timeout(30_000) });
				if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
				return (await res.json()) as any;
			},
			text: async (url) => {
				const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
				if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
				return res.text();
			},
			log: () => {},
		};
	}

	private async runUpdate(j: Job, it: Item) {
		const target = j.target ?? it.state.latest;
		if (!target) throw new Error("No newer version known: check first");
		const from = it.state.installed;
		const you = j.by === "you";
		// While you're here, a password prompt can reach you; unattended, it fails fast.
		const env = you ? { SUDO_ASKPASS: this.askpass, UPKEEP_ASKPASS_PROMPT: `Upkeep needs your administrator password to update ${it.name}.` } : {};
		const ctx = this.ctx(j, env);
		const plan = await this.plan(it, target, ctx);
		this.log(j, `${it.name}: ${from ?? "?"} → ${target}${you ? "" : ` (${j.by === "auto" ? "automatic" : "scheduled"})`}`);
		for (const w of plan.warnings) this.log(j, w, "warning");
		if (!you) {
			const why = planBlocker(plan) ?? autoBlocker(it, this.settings, { onAC: await onAC(), hour: new Date().getHours() });
			if (why) {
				j.result = `Not updated automatically: ${why}`;
				j.tone = "muted";
				this.record({ event: "skipped", item: it.id, name: it.name, text: j.result, tone: "muted", job: j.id, by: j.by });
				return;
			}
		}
		if (plan.unverified) {
			if (it.reviewed !== recipeHash(it.data)) throw new Error("Review this recipe before it runs");
			this.log(j, "Running your own command (unverified).", "warning");
		}
		if (it.provider === "git") {
			const why = await gitPrecheck(it, ctx);
			if (why) throw new Error(why);
		}
		this.record({ event: "started", item: it.id, name: it.name, text: `Updating ${from ?? "?"} → ${target}: ${plan.steps.map((s) => s.label ?? show(s.argv)).join(" && ")}`, tone: "info", job: j.id, by: j.by });

		// A running app: quit it first (you agreed in the review dialog); never automatically.
		let teamBefore: string | undefined;
		if (plan.app) {
			if (await appRunning(plan.app.path)) {
				if (!you) throw new Error(`${plan.app.name} is running`);
				this.log(j, `Quitting ${plan.app.name}…`);
				const app = plan.app.bundleId ? `application id ${JSON.stringify(plan.app.bundleId)}` : `application ${JSON.stringify(plan.app.path)}`;
				await ctx.run(["/usr/bin/osascript", "-e", `tell ${app} to quit`], { timeoutMs: 30_000 });
				for (let i = 0; i < 30 && (await appRunning(plan.app.path)); i++) await Bun.sleep(1000);
				if (await appRunning(plan.app.path)) throw new Error(`${plan.app.name} didn't quit (unsaved work?). Quit it and try again.`);
			}
			teamBefore = await teamId(plan.app.path);
			if (teamBefore) this.log(j, `Signed by team ${teamBefore}`, "muted");
		}

		try {
			for (const step of plan.steps) await this.step(j, ctx, step, it);
		} finally {
			if (you && plan.needsAuth) await run(["/usr/bin/sudo", "-k"], { env: baseEnv(), timeoutMs: 5000 }).catch(() => {});
		}

		if (plan.handoff) {
			it.state.nextAt = Date.now() + 10 * MIN;
			this.save();
			j.result = `Opened. ${plan.handoff.split(".")[0]}. Upkeep checks again in 10 minutes.`;
			j.tone = "info";
			this.record({ event: "update", item: it.id, name: it.name, text: j.result, tone: "info", job: j.id, by: j.by });
			return;
		}

		// Did it work? Check again, compare versions and the signature.
		this.log(j, "Checking the result…", "muted");
		const after = await provider(it.provider)!.check(it, ctx);
		const previous = it.state.installed;
		this.applyCheck(it, after);
		const got = it.state.installed;
		let tone: Tone = "success";
		let text = `Updated ${previous ?? "?"} → ${got ?? "?"}`;
		if (it.provider !== "git" && got && compare(got, target) < 0) {
			tone = "warning";
			text = `Ran without errors, but it's at ${got}, not ${target}`;
		}
		if (plan.app && teamBefore) {
			const teamAfter = await teamId(plan.app.path);
			if (teamAfter !== teamBefore) {
				tone = "danger";
				text += ` · SIGNATURE CHANGED: team ${teamBefore} → ${teamAfter ?? "unsigned"}`;
			} else this.log(j, `Signature checked: team ${teamAfter}`, "success");
		}
		if (previous && previous !== got) it.state.previous = previous;
		it.state.updatedAt = Date.now();
		this.save();
		for (const sib of this.siblings(it)) this.enqueue("check", sib, j.by);
		j.result = text;
		j.tone = tone;
		this.record({ event: "update", item: it.id, name: it.name, text, tone, job: j.id, by: j.by, detail: { from: previous ?? "", to: got ?? "" } });
	}

	private async step(j: Job, ctx: Ctx, step: Step, it: Item) {
		if (step.label) this.log(j, step.label, "info");
		const r = await ctx.run(step.argv, { cwd: step.cwd, env: step.env, timeoutMs: step.timeoutMs ?? 30 * MIN });
		if (r.cancelled) throw new Error("Cancelled");
		if (r.timedOut) throw new Error(`Timed out: ${show(step.argv)}`);
		if (r.code !== 0) {
			const text = r.err + r.out;
			if (askedForPassword(text)) {
				it.state.needsAuth = true;
				it.state.blocked = "Asked for a password: start it yourself";
				this.save();
				throw new Error("It asked for a password. Upkeep marked it as needing you; start the update yourself.");
			}
			throw new Error(`${show(step.argv)} failed (exit ${r.code}): ${text.trim().split("\n").slice(-2).join(" ")}`);
		}
	}

	// ── rollback ──────────────────────────────────────────────────────────
	private async runRollback(j: Job, it: Item) {
		const p = provider(it.provider)!;
		const to = it.state.previous;
		const plan = to && p.rollback?.(it, to);
		if (!to || !plan) throw new Error("Nothing to roll back to");
		const ctx = this.ctx(j);
		for (const w of plan.warnings) this.log(j, w, "warning");
		for (const step of plan.steps) await this.step(j, ctx, step, it);
		const from = it.state.installed;
		this.applyCheck(it, await p.check(it, ctx));
		it.state.previous = undefined;
		this.save();
		j.result = `Rolled back ${from} → ${it.state.installed}`;
		j.tone = "success";
		this.record({ event: "rollback", item: it.id, name: it.name, text: j.result, tone: "success", job: j.id, by: j.by });
	}

	// ── schedule ──────────────────────────────────────────────────────────
	tick(now = Date.now()) {
		for (const it of this.items) if (it.state.nextAt <= now) this.enqueue("check", it, "schedule");
	}

	nextCheck = () => this.items.reduce<number | undefined>((m, it) => (m === undefined || it.state.nextAt < m ? it.state.nextAt : m), undefined);
	updates = () => this.items.filter(hasUpdate);
	needsYou = () => this.items.filter((it) => hasUpdate(it) && (it.state.blocked || it.state.needsAuth));
	active = () => this.jobs.filter((j) => j.state === "running" || j.state === "queued");
}

// ── macOS helpers ─────────────────────────────────────────────────────────
export async function onAC(): Promise<boolean> {
	const r = await run(["/usr/bin/pmset", "-g", "batt"], { timeoutMs: 5000 }).catch(() => null);
	return !r || !r.out.includes("Battery Power");
}

export async function appRunning(app: string): Promise<boolean> {
	const r = await run(["/usr/bin/pgrep", "-f", `${app}/Contents/MacOS/`], { timeoutMs: 5000 }).catch(() => null);
	return r?.code === 0;
}

/** The Team ID an app is signed by (codesign prints it on stderr). */
export async function teamId(app: string): Promise<string | undefined> {
	const r = await run(["/usr/bin/codesign", "-dv", "--verbose=2", app], { timeoutMs: 30_000 }).catch(() => null);
	return r?.err.match(/TeamIdentifier=(\S+)/)?.[1] ?? undefined;
}

/**
 * `sudo -A` runs this to ask for the password: a native dialog naming what it's for. The
 * password goes to sudo on stdout and nowhere else.
 */
const ASKPASS = `#!/bin/sh
# Upkeep's password prompt for sudo -A (SUDO_ASKPASS). Shows a macOS dialog; the password goes
# to sudo on stdout and is never stored. Cancel makes sudo fail.
exec /usr/bin/osascript \\
  -e 'on run argv' \\
  -e 'display dialog (item 1 of argv) default answer "" with hidden answer with title "Upkeep" with icon caution buttons {"Cancel", "OK"} default button "OK"' \\
  -e 'return text returned of result' \\
  -e 'end run' \\
  "\${UPKEEP_ASKPASS_PROMPT:-Upkeep needs your administrator password.}"
`;
