// The engine's rules and flows, with real processes against a temporary data folder. Uses a
// custom recipe (shell commands on a file) so nothing outside the temp folder is touched.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, autoBlocker, backoff, hasUpdate, jitter, planBlocker } from "../lib/engine";
import { askedForPassword, run } from "../lib/exec";
import { DEFAULT_SETTINGS, Store } from "../lib/store";
import type { Item } from "../lib/types";
import { customCandidate, recipeHash } from "../providers/custom";

const HOUR = 3_600_000;

function item(over: Partial<Item> = {}, state: Partial<Item["state"]> = {}): Item {
	return { id: "brew:act", provider: "brew", ref: "act", name: "act", kind: "package", identity: "tool:act", data: {}, addedAt: 0, policy: "minor", ...over, state: { installed: "1.2.3", latest: "1.2.4", outdated: true, failures: 0, nextAt: 0, ...state } };
}
const on = { ...DEFAULT_SETTINGS, autoUpdates: true };
const env = { onAC: true, hour: 3 };

describe("automatic updates: only when everything allows it", () => {
	test("off by default, and notify-only items never", () => {
		expect(DEFAULT_SETTINGS.autoUpdates).toBe(false);
		expect(autoBlocker(item(), DEFAULT_SETTINGS, env)).toBe("automatic updates are off");
		expect(autoBlocker(item({ policy: "notify" }), on, env)).toBe("notify only");
		expect(autoBlocker(item(), on, env)).toBeNull();
	});
	test("the policy limits the step", () => {
		expect(autoBlocker(item({ policy: "patch" }, { latest: "1.3.0" }), on, env)).toContain("minor update is beyond");
		expect(autoBlocker(item({ policy: "minor" }, { latest: "2.0.0" }), on, env)).toContain("major update is beyond");
		expect(autoBlocker(item({ policy: "all" }, { latest: "2.0.0" }), on, env)).toBeNull();
	});
	test("never: passwords, blocked items, own commands, apps that update themselves, pinned, skipped", () => {
		expect(autoBlocker(item({}, { needsAuth: true }), on, env)).toBe("needs your password");
		expect(autoBlocker(item({}, { blocked: "Has uncommitted changes" }), on, env)).toBe("Has uncommitted changes");
		expect(autoBlocker(item({ provider: "custom" }), on, env)).toContain("never");
		expect(autoBlocker(item({ provider: "sparkle" }), on, env)).toContain("never");
		expect(autoBlocker(item({ pinned: true }), on, env)).toBe("no update");
		expect(autoBlocker(item({ skip: "1.2.4" }), on, env)).toBe("no update");
		expect(planBlocker({ steps: [], needsAuth: true, warnings: [] })).toBe("needs your password");
		expect(planBlocker({ steps: [], handoff: "opens the app", warnings: [] })).toBe("updates in its own app");
		expect(planBlocker({ steps: [], unverified: true, warnings: [] })).toBe("unverified command");
	});
	test("power and time window", () => {
		expect(autoBlocker(item(), on, { onAC: false, hour: 3 })).toBe("on battery");
		expect(autoBlocker(item(), { ...on, acOnly: false }, { onAC: false, hour: 3 })).toBeNull();
		expect(autoBlocker(item(), { ...on, window: "night" }, { onAC: true, hour: 14 })).toContain("outside");
	});
	test("a skipped version stops counting; a newer one counts again", () => {
		expect(hasUpdate(item({ skip: "1.2.4" }))).toBe(false);
		expect(hasUpdate(item({ skip: "1.2.4" }, { latest: "1.2.5" }))).toBe(true);
	});
});

test("schedule: jitter within ±5 %, back-off doubles up to the interval", () => {
	expect(jitter(6 * HOUR, 0)).toBe(Math.round(6 * HOUR * 0.95));
	expect(jitter(6 * HOUR, 1)).toBe(Math.round(6 * HOUR * 1.05));
	expect([1, 2, 3, 4, 10].map((f) => backoff(f, 6 * HOUR) / 60_000)).toEqual([15, 30, 60, 120, 360]);
});

describe("commands", () => {
	test("input is closed: nothing can wait for typing", async () => {
		const r = await run(["/bin/cat"], { timeoutMs: 5000 });
		expect(r).toMatchObject({ code: 0, timedOut: false });
	});
	test("timeouts and cancelling stop the command", async () => {
		const t = await run(["/bin/sleep", "10"], { timeoutMs: 200 });
		expect(t.timedOut).toBe(true);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const c = await run(["/bin/sleep", "10"], { signal: ac.signal });
		expect(c.cancelled).toBe(true);
	});
	test("output streams line by line; progress redraws keep the last state", async () => {
		const lines: string[] = [];
		await run(["/bin/sh", "-c", "printf 'a\\nprogress 1\\rprogress 2\\nb'"], { onLine: (l) => lines.push(l.text) });
		expect(lines).toEqual(["a", "progress 2", "b"]);
	});
	test("password prompts are recognised", () => {
		expect(askedForPassword("sudo: a terminal is required to read the password")).toBe(true);
		expect(askedForPassword("Error: everything is fine")).toBe(false);
	});
});

describe("engine flows", () => {
	let engine: Engine | undefined;
	afterEach(() => engine?.stop());

	const until = async (check: () => boolean, ms = 10_000) => {
		const end = Date.now() + ms;
		while (!check()) {
			if (Date.now() > end) throw new Error("timed out");
			await Bun.sleep(20);
		}
	};

	function setup() {
		const dir = mkdtempSync(join(tmpdir(), "upkeep-"));
		const file = join(dir, "version");
		writeFileSync(file, "1.0.0\n");
		engine = new Engine(new Store(join(dir, "data")), () => {});
		const cand = customCandidate({ name: "Fake", version: `cat '${file}'`, latest: "echo 1.1.0", update: `echo updating; echo 1.1.0 > '${file}'` });
		return { dir, file, cand, e: engine };
	}

	test("a fresh install watches nothing and starts no jobs", () => {
		const { e } = setup();
		e.tick(Date.now() + 365 * 24 * HOUR);
		expect(e.items).toEqual([]);
		expect(e.jobs).toEqual([]);
		expect(e.settings.autoUpdates).toBe(false);
	});

	test("add → check → update → verified, all in the audit log and job logs", async () => {
		const { e, cand, file } = setup();
		const [it] = e.add([cand], { reviewed: recipeHash(cand.data) });
		await until(() => !!it.state.checkedAt);
		expect(it.state).toMatchObject({ installed: "1.0.0", latest: "1.1.0", outdated: true });
		const job = e.enqueue("update", it, "you", "1.1.0")!;
		await until(() => job.state !== "running" && job.state !== "queued");
		expect(job.state).toBe("done");
		expect(job.result).toBe("Updated 1.0.0 → 1.1.0");
		expect(readFileSync(file, "utf8").trim()).toBe("1.1.0");
		expect(it.state).toMatchObject({ installed: "1.1.0", outdated: false, previous: "1.0.0" });
		expect(e.audit.map((a) => a.event)).toEqual(["added", "check", "started", "update"]);
		expect(e.store.readLog(job.id).join("\n")).toContain("updating");
		// survives a restart
		expect(new Store(e.store.dir).items()[0].state.installed).toBe("1.1.0");
	});

	test("a recipe that changed since you reviewed it doesn't run", async () => {
		const { e, cand, file } = setup();
		const [it] = e.add([cand], { reviewed: "something else" });
		await until(() => !!it.state.checkedAt);
		expect(it.state.error).toContain("review it again");
		const job = e.enqueue("update", it, "you", "1.1.0")!;
		await until(() => job.state === "failed");
		expect(readFileSync(file, "utf8").trim()).toBe("1.0.0");
	});

	test("a scheduled check never updates your own commands, even with everything on", async () => {
		const { e, cand, file } = setup();
		e.setSettings({ autoUpdates: true, acOnly: false });
		const [it] = e.add([cand], { reviewed: recipeHash(cand.data), policy: "all" });
		await until(() => !!it.state.checkedAt);
		it.state.nextAt = 0;
		e.tick();
		await until(() => e.jobs.filter((j) => j.type === "check").every((j) => j.state === "done") && e.jobs.filter((j) => j.type === "check").length === 2);
		await Bun.sleep(100);
		expect(e.jobs.some((j) => j.type === "update")).toBe(false);
		expect(readFileSync(file, "utf8").trim()).toBe("1.0.0");
	});

	test("failed checks back off and are recorded", async () => {
		const { e } = setup();
		const bad = customCandidate({ name: "Broken", version: "exit 3", latest: "echo 1", update: "true" });
		const [it] = e.add([bad], { reviewed: recipeHash(bad.data) });
		await until(() => it.state.failures === 1);
		expect(it.state.nextAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
		expect(e.audit.at(-1)).toMatchObject({ event: "check", tone: "danger" });
	});

	test("cancelling a running update stops it and records it", async () => {
		const { e, file } = setup();
		const slow = customCandidate({ name: "Slow", version: `cat '${file}'`, latest: "echo 9.0.0", update: `sleep 5; echo 9.0.0 > '${file}'` });
		const [it] = e.add([slow], { reviewed: recipeHash(slow.data) });
		await until(() => !!it.state.checkedAt);
		const job = e.enqueue("update", it, "you")!;
		await until(() => job.state === "running");
		await Bun.sleep(200);
		e.cancel(job.id);
		await until(() => job.state === "cancelled");
		await Bun.sleep(5500);
		expect(readFileSync(file, "utf8").trim()).toBe("1.0.0");
		expect(e.audit.at(-1)).toMatchObject({ event: "cancelled" });
	}, 15_000);
});
