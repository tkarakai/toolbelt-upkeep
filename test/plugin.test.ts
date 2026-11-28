// Upkeep under the SDK's fake host, which checks what ToolBelt checks: messages, results and
// every rendered action and form id against the declarations. Software comes from a fake
// provider whose "update" writes a file in a temporary folder, and custom recipes run commands on
// files there: nothing on this Mac is checked or updated.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON, RESERVED_EVENTS, type Node } from "@toolbelt/sdk";
import { fakeHost } from "@toolbelt/sdk/testing";
import { createUpkeep } from "../plugin";
import type { Candidate, Item, Provider } from "../lib/types";
import { PROVIDERS } from "../providers";
import { customCandidate, recipeHash } from "../providers/custom";
import { ACTIONS, AUTO_UPDATES_CONFIRM, FORMS } from "../ui";

const root = mkdtempSync(join(tmpdir(), "upkeep-plugin-"));
const shell = process.env.SHELL;
const AGENT = "agent:s1:monitored";

/** A provider that knows only files in `root`: `<ref>.installed` and `<ref>.latest`. */
const fake: Provider = {
	id: "fake",
	label: "Fake provider",
	available: async () => true,
	discover: async () => [],
	check: async (item) => ({ installed: readFileSync(join(root, `${item.ref}.installed`), "utf8").trim(), latest: readFileSync(join(root, `${item.ref}.latest`), "utf8").trim() }),
	plan: async (item, target) => ({ steps: [{ argv: ["/bin/sh", "-c", `printf %s "$1" > "$2"`, "sh", target, join(root, `${item.ref}.installed`)], label: `fake install ${target}` }], warnings: [] }),
	recipe: () => ({ check: "fake check", update: "fake update" }),
};

beforeAll(() => {
	// Starting the plugin reads the login PATH: keep the person's shell startup files out of it.
	process.env.SHELL = "/usr/bin/true";
	PROVIDERS.push(fake);
});
afterAll(() => {
	process.env.SHELL = shell;
	PROVIDERS.splice(PROVIDERS.indexOf(fake), 1);
	rmSync(root, { recursive: true, force: true });
});

let cleanup: (() => void)[] = [];
afterEach(() => {
	for (const f of cleanup) f();
	cleanup = [];
});

const now = Date.now();
function fakeItem(ref: string, installed: string, latest: string, over: Partial<Item> = {}): Item {
	writeFileSync(join(root, `${ref}.installed`), installed);
	writeFileSync(join(root, `${ref}.latest`), latest);
	return { id: `fake:${ref}`, provider: "fake", ref, name: ref, kind: "package", identity: `fake:${ref}`, data: {}, addedAt: now, policy: "notify", ...over, state: { installed, latest, outdated: latest !== installed, checkedAt: now, nextAt: now + 86_400_000, failures: 0, ...over.state } };
}

/** A plugin with these items (and Discover candidates) in a fresh data folder, under the fake host. */
async function start(items: Item[] = [], candidates: Candidate[] = []) {
	const dir = mkdtempSync(join(root, "data-"));
	writeFileSync(join(dir, "items.json"), JSON.stringify(items));
	if (candidates.length) writeFileSync(join(dir, "discovered.json"), JSON.stringify({ at: now, candidates, errors: {} }));
	const upkeep = createUpkeep(dir);
	const host = fakeHost(upkeep.definition);
	cleanup.push(() => {
		upkeep.engine.stop();
		host.close();
	});
	await host.hello();
	return { ...upkeep, host, dir };
}

const find = (node: unknown, pred: (n: any) => boolean): any => {
	if (!node || typeof node !== "object") return undefined;
	if (pred(node)) return node;
	for (const v of Object.values(node)) {
		const hit = Array.isArray(v) ? v.map((c) => find(c, pred)).find(Boolean) : typeof v === "object" ? find(v, pred) : undefined;
		if (hit) return hit;
	}
	return undefined;
};
const table = (tree: Node | undefined, id: string) => find(tree, (n) => n.type === "table" && n.id === id);
const row = (tree: Node | undefined, id: string) => table(tree, "items")?.rows.find((r: any) => r.id === id);
const until = async (check: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(10);
	}
};

test("declarations: every action and form, with honest effects; none is a built-in event", async () => {
	const { host } = await start();
	expect(host.declarations.actions).toEqual(ACTIONS);
	expect(host.declarations.forms).toEqual(FORMS);
	for (const id of Object.keys(ACTIONS)) expect(RESERVED_EVENTS as readonly string[]).not.toContain(id);
	const effect = (id: string) => ACTIONS[id].effect;
	for (const id of ["update", "update-app", "update-major", "update-auth", "update-own", "update-open", "update-many", "update-safe", "update-now", "rollback", "terminal"]) expect(effect(id)).toBe("external");
	for (const id of ["remove", "remove-many"]) expect(effect(id)).toBe("destructive");
	for (const id of ["review", "notes", "review-safe", "settings", "history", "log", "add-recipe", "run-dismiss"]) expect(effect(id)).toBe("view");
	// Only the person runs a recipe review or hands an update to their Terminal.
	for (const id of ["terminal", "review-recipe", "recipe-approve"]) expect(ACTIONS[id].agent).toBe(false);
	expect(FORMS).toEqual({ settings: { effect: "write" }, item: { effect: "write" }, recipe: { effect: "view" } });
});

test("every screen, dialog and run card renders with declared ids only, for the person and an agent", async () => {
	const up = fakeItem("minor", "1.0.0", "1.1.0");
	const major = fakeItem("major", "1.0.0", "2.0.0");
	const blocked = fakeItem("blocked", "1.0.0", "1.1.0", { state: { blocked: "Has local changes" } as Item["state"] });
	const done = fakeItem("done", "1.0.0", "1.0.0");
	const recipe = { ...customCandidate({ name: "Reviewed recipe", version: "echo 1", latest: "echo 1", update: "true" }), addedAt: now, policy: "notify" as const, state: { outdated: false, nextAt: now + 86_400_000, failures: 0 } };
	const reviewedRecipe = { ...recipe, reviewed: recipeHash(recipe.data) };
	const unreviewed = { ...customCandidate({ name: "Unreviewed recipe", version: "echo 1", latest: "echo 1", update: "true" }), addedAt: now, policy: "notify" as const, state: { outdated: false, nextAt: now + 86_400_000, failures: 0 } };
	const candidate: Candidate = { id: "fake:new", provider: "fake", ref: "new", name: "new", kind: "package", identity: "fake:new", data: {}, installed: "1" };
	const { host, engine } = await start([up, major, blocked, done, reviewedRecipe, unreviewed], [candidate, { ...candidate, id: up.id, ref: "minor", name: "minor" }]);
	const surfaces = ["screen:monitored", "screen:discover", "screen:activity", "screen:settings", "quick"];
	for (const s of surfaces) await host.open(s);
	for (const s of surfaces.filter((s) => s !== "quick")) await host.open(s, `agent:s1:${s.slice(7)}`);
	// Runs: one finished with a card, one running (an update whose fake install waits a moment).
	await host.event("screen:monitored", "check", { rowId: done.id });
	const slow = { ...fake, id: "fake", plan: async () => ({ steps: [{ argv: ["/bin/sleep", "0.3"] }], warnings: [] }) };
	PROVIDERS.splice(PROVIDERS.indexOf(fake), 1, slow);
	cleanup.push(() => PROVIDERS.splice(PROVIDERS.indexOf(slow), 1, fake));
	await host.event("screen:monitored", "update", { rowId: up.id });
	await host.idle();
	// Each dialog, in the person's instance and an agent's.
	for (const instance of [PERSON, AGENT]) {
		for (const [name, payload] of [["review", { rowId: major.id }], ["review-safe", {}], ["settings", { rowId: up.id }], ["history", { rowId: up.id }], ["log", { rowId: engine.jobs[0].id }]] as const) {
			const r = await host.event("screen:monitored", name, payload, { instance, origin: instance === PERSON ? "person" : "agent" });
			expect(r).toMatchObject({ handled: true });
			await until(() => !!(host.tree("screen:monitored", instance) as any)?.dialog);
			expect(host.rejected).toEqual([]);
			await host.event("screen:monitored", "dialog-close", { dialog: "x" }, { instance, origin: instance === PERSON ? "person" : "agent" });
		}
	}
	// The person's screens share one dialog: the recipe draft, then a recipe review.
	await host.event("screen:settings", "add-recipe");
	expect(host.tree("screen:settings")).toMatchObject({ dialog: { id: "recipe" } });
	await host.event("screen:monitored", "review-recipe", { rowId: unreviewed.id });
	expect(host.tree("screen:monitored")).toMatchObject({ dialog: { id: "recipe-review" } });
	await until(() => engine.jobs.every((j) => j.state !== "queued" && j.state !== "running"));
	await Bun.sleep(300); // the coalesced redraw
	expect(host.rejected).toEqual([]);
	expect(host.invalid).toEqual([]);
	for (const s of surfaces) expect(host.tree(s)).toBeDefined();
	expect(find(host.tree("screen:monitored"), (n) => n.type === "card" && n.title === "Update minor")).toBeDefined();
});

test("an update runs only as the action the row offers, and returns its run and job ids", async () => {
	const minor = fakeItem("minor", "1.0.0", "1.1.0");
	const blocked = fakeItem("blocked", "1.0.0", "1.1.0", { state: { blocked: "Has local changes" } as Item["state"] });
	const { host, engine } = await start([minor, blocked]);
	await host.open("screen:monitored");
	await host.open("screen:monitored", AGENT);
	expect(row(host.tree("screen:monitored", AGENT), minor.id).actions[0]).toBe("update");

	// Another update id carries another confirmation: refused, nothing starts.
	for (const name of ["update-major", "update-app", "update-auth", "update-own", "update-open"]) {
		const r = await host.event("screen:monitored", name, { rowId: minor.id }, { instance: AGENT, origin: "agent" });
		expect(r.handled).toBe(true);
		expect(r.error).toContain("now offers a different update (update");
	}
	const r = await host.event("screen:monitored", "update", { rowId: blocked.id }, { instance: AGENT, origin: "agent" });
	expect(r.error).toContain("has no update to start now");
	expect(engine.jobs).toEqual([]);
	// The person sees the error where they acted; an agent gets it in the result only.
	expect(r.toasts).toEqual([]);
	const mine = await host.event("screen:monitored", "update-major", { rowId: minor.id });
	expect(mine.toasts.map((t) => t.tone)).toEqual(["error"]);

	const ok = await host.event("screen:monitored", "update", { rowId: minor.id }, { instance: AGENT, origin: "agent" });
	expect(ok.error).toBeUndefined();
	const data = ok.data as { run: string; jobs: string[] };
	expect(data.run).toBe(engine.runs[0].id);
	expect(data.jobs).toEqual([engine.jobs[0].id]);
	expect(engine.jobs[0]).toMatchObject({ type: "update", by: "agent", itemId: minor.id });
	await until(() => engine.item(minor.id)!.state.installed === "1.1.0");
	expect(readFileSync(join(root, "minor.installed"), "utf8")).toBe("1.1.0");
	expect(engine.audit.at(-1)).toMatchObject({ event: "update", by: "agent" });
	// Busy now? Nothing more starts, and the row offers no update.
	expect(row(host.tree("screen:monitored"), minor.id).actions).not.toContain("update");
});

test("checks, batches and watching return what they started", async () => {
	const a = fakeItem("a", "1.0.0", "1.0.1");
	const b = fakeItem("b", "1.0.0", "2.0.0");
	const cand: Candidate = { id: "fake:c", provider: "fake", ref: "c", name: "c", kind: "package", identity: "fake:c", data: {}, installed: "1.0.0" };
	writeFileSync(join(root, "c.installed"), "1.0.0");
	writeFileSync(join(root, "c.latest"), "1.0.0");
	const { host, engine } = await start([a, b], [cand]);
	for (const s of ["screen:monitored", "screen:discover"]) await host.open(s, `agent:s1:${s.slice(7)}`);
	const as = (s: string) => ({ instance: `agent:s1:${s.slice(7)}`, origin: "agent" as const });

	const check = await host.event("screen:monitored", "check", { rowId: a.id }, as("screen:monitored"));
	const job = engine.jobs.at(-1)!;
	expect(check.data).toEqual({ run: job.run, job: job.id });
	const all = await host.event("screen:monitored", "check-many", { rowIds: [a.id, b.id] }, as("screen:monitored"));
	expect(all.data).toMatchObject({ run: expect.any(String), jobs: expect.any(Array) });
	await until(() => engine.active().length === 0);

	// A batch leaves out what needs individual review and says which.
	const many = await host.event("screen:monitored", "update-many", { rowIds: [a.id, b.id] }, as("screen:monitored"));
	expect(many.data).toMatchObject({ run: expect.any(String), notIncluded: [b.id] });
	expect((many.data as { jobs: string[] }).jobs).toHaveLength(1);
	expect(many.toasts[0].text).toContain("1 of the selected needs individual review");
	await until(() => engine.active().length === 0);

	const watch = await host.event("screen:discover", "monitor", { rowId: cand.id }, as("screen:discover"));
	// (Bun's asymmetric matchers write into what they match: compare copies.)
	expect(structuredClone(watch.data)).toMatchObject({ watching: [cand.id], run: expect.any(String) });
	expect(engine.getRun((watch.data as { run: string }).run)?.by).toBe("agent");
	await until(() => engine.active().length === 0);
	// Nothing started (Upkeep is stopping): said so, with no ids.
	expect(engine.prepareShutdown()).toEqual({ ready: true });
	const none = await host.event("screen:monitored", "check", { rowId: a.id }, as("screen:monitored"));
	expect(structuredClone(none.data)).toMatchObject({ run: null, reason: expect.stringContaining("Nothing started") });
});

test("a recipe an agent saves is never marked reviewed and doesn't run until the person reviews it", async () => {
	const { host, engine } = await start();
	const SETTINGS = "agent:s1:settings";
	await host.open("screen:settings");
	await host.open("screen:settings", SETTINGS);
	await host.open("screen:monitored");
	const as = { instance: SETTINGS, origin: "agent" as const, agent: "Claude Code" };
	const version = join(root, "recipe-version");
	writeFileSync(version, "1.0.0");
	await host.event("screen:settings", "add-recipe", {}, as);
	expect(host.tree("screen:settings", SETTINGS)).toMatchObject({ dialog: { id: "recipe", actions: [{ id: "recipe-save", label: "Add for review" }] } });
	// The draft is the agent's: the person's screen shows no dialog.
	expect((host.tree("screen:settings") as any).dialog).toBeUndefined();
	const fields = { name: "Agent recipe", version: `/bin/cat '${version}'`, latest: "/bin/echo 1.1.0", update: `/bin/echo 1.1.0 > '${version}'` };
	for (const [field, value] of Object.entries(fields)) expect(await host.event("screen:settings", "field", { form: "recipe", field, value }, as)).toMatchObject({ handled: true });
	const saved = await host.event("screen:settings", "recipe-save", { dialog: "recipe" }, as);
	expect(saved.data).toEqual({ item: "custom:agent-recipe", reviewed: false });
	const it = engine.item("custom:agent-recipe")!;
	expect(it.reviewed).toBeUndefined();
	expect(engine.jobs).toEqual([]); // not even checked
	expect(engine.audit.at(-1)?.by).toBe("agent");
	expect(engine.audit.at(-1)?.text).toContain("Added by Claude Code, not reviewed");
	await host.idle();
	await Bun.sleep(300);
	const r = row(host.tree("screen:monitored"), it.id);
	expect(r.actions).toEqual(["review-recipe", "notes", "settings", "history", "pin", "remove"]);
	expect(r.cells.status.text).toBe("Review its commands before they run");
	// Starting it anyway fails without running anything.
	const forced = await host.event("screen:monitored", "check", { rowId: it.id });
	expect(forced.data).toMatchObject({ job: expect.any(String) });
	await until(() => engine.active().length === 0);
	expect(it.state.error).toContain("Nobody has reviewed this recipe");
	expect(readFileSync(version, "utf8")).toBe("1.0.0");

	// An agent can't review it, even by sending the person's actions.
	expect(await host.event("screen:monitored", "review-recipe", { rowId: it.id }, { instance: AGENT, origin: "agent" })).toMatchObject({ handled: false });
	expect(await host.event("screen:monitored", "recipe-approve", { dialog: "recipe-review" }, { instance: AGENT, origin: "agent" })).toMatchObject({ handled: false });
	expect(it.reviewed).toBeUndefined();

	// The person reviews it: now it's checked.
	await host.event("screen:monitored", "review-recipe", { rowId: it.id });
	expect(host.tree("screen:monitored")).toMatchObject({ dialog: { id: "recipe-review", actions: [{ id: "recipe-approve" }] } });
	const approved = await host.event("screen:monitored", "recipe-approve", { dialog: "recipe-review" });
	expect(approved.data).toMatchObject({ job: expect.any(String) });
	expect(it.reviewed).toBe(recipeHash(it.data));
	await until(() => it.state.latest === "1.1.0");

	// The person's own save is their review.
	await host.event("screen:settings", "add-recipe");
	for (const [field, value] of Object.entries({ ...fields, name: "My recipe" })) await host.event("screen:settings", "field", { form: "recipe", field, value });
	expect((await host.event("screen:settings", "recipe-save", { dialog: "recipe" })).data).toEqual({ item: "custom:my-recipe", reviewed: true });
	expect(engine.item("custom:my-recipe")!.reviewed).toBe(recipeHash(engine.item("custom:my-recipe")!.data));
});

test("turning on automatic updates and stopping watching ask first", async () => {
	const item = fakeItem("watched", "1.0.0", "1.0.0");
	const { host, engine } = await start([item], [{ id: item.id, provider: "fake", ref: "watched", name: "watched", kind: "package", identity: item.identity, data: {}, installed: "1.0.0" }]);
	for (const s of ["screen:settings", "screen:discover", "screen:monitored"]) await host.open(s);
	const card = () => find(host.tree("screen:settings"), (n) => n.type === "card" && n.id === "auto");
	expect(card().actions).toEqual([{ id: "auto-updates-on", label: "Allow automatic updates", checked: false, confirm: AUTO_UPDATES_CONFIRM }]);
	// It's no longer a form field anyone could flip without the question.
	expect(find(host.tree("screen:settings"), (n) => n.id === "autoUpdates")).toBeUndefined();
	expect(await host.event("screen:settings", "field", { form: "settings", field: "autoUpdates", value: true })).toMatchObject({ handled: false });
	expect(engine.settings.autoUpdates).toBe(false);
	await host.event("screen:settings", "auto-updates-on", { rowId: "auto" }, { instance: PERSON, origin: "person" });
	expect(engine.settings.autoUpdates).toBe(true);
	expect(card().actions).toEqual([{ id: "auto-updates-off", label: "Allow automatic updates", checked: true }]);
	await host.event("screen:settings", "auto-updates-on", { rowId: "auto" });
	expect(engine.settings.autoUpdates).toBe(true); // turning on is idempotent, never a toggle
	await host.event("screen:settings", "auto-updates-off", { rowId: "auto" });
	expect(engine.settings.autoUpdates).toBe(false);

	const confirmOf = (tree: Node | undefined, id: string) => table(tree, id).actions.find((a: any) => a.id === "remove").confirm;
	expect(confirmOf(host.tree("screen:discover"), "candidates")).toContain("nothing is uninstalled");
	expect(confirmOf(host.tree("screen:monitored"), "items")).toContain("Nothing is uninstalled");
	expect(find(host.tree("screen:monitored"), (n) => n.id === "remove-many")?.confirm).toBeString();
});

test("dialogs belong to their instance, and a run's toast reaches the person unless they're watching it", async () => {
	const a = fakeItem("a", "1.0.0", "1.0.1");
	const { host, engine } = await start([a]);
	await host.open("screen:monitored", AGENT);
	await host.event("screen:monitored", "history", { rowId: a.id }, { instance: AGENT, origin: "agent" });
	expect(host.tree("screen:monitored", AGENT)).toMatchObject({ dialog: { id: "history" } });
	await host.open("screen:monitored");
	expect((host.tree("screen:monitored") as any).dialog).toBeUndefined();
	await host.event("screen:monitored", "settings", { rowId: a.id });
	expect(host.tree("screen:monitored")).toMatchObject({ dialog: { id: "settings" } });
	expect(host.tree("screen:monitored", AGENT)).toMatchObject({ dialog: { id: "history" } });
	// The agent's instance closing takes its dialog with it; the person's stays.
	await host.closeInstance("screen:monitored", AGENT);
	await host.open("screen:monitored", AGENT);
	expect((host.tree("screen:monitored", AGENT) as any).dialog).toBeUndefined();
	expect(host.tree("screen:monitored")).toMatchObject({ dialog: { id: "settings" } });
	await host.event("screen:monitored", "dialog-close", { dialog: "settings" });

	// Only the agent has the screen open: its finished check reaches the person as a toast.
	await host.closeInstance("screen:monitored");
	const toasts = () => host.messages.filter((m) => m.type === "toast");
	await host.event("screen:monitored", "check", { rowId: a.id }, { instance: AGENT, origin: "agent" });
	await until(() => toasts().length === 1);
	expect(structuredClone(toasts()[0])).toMatchObject({ text: expect.stringMatching(/^Agent: Check a: /), action: { id: "show-run" } });
	expect(toasts()[0]).not.toHaveProperty("event"); // sent after the event: the person's

	// The person watching the card: no toast. Dismissing it is theirs alone.
	await host.open("screen:monitored");
	await host.event("screen:monitored", "check", { rowId: a.id });
	await until(() => engine.active().length === 0);
	await Bun.sleep(50);
	expect(toasts()).toHaveLength(1);
	const run = engine.runs.at(-1)!;
	await host.event("screen:monitored", "run-dismiss", { rowId: run.id }, { instance: AGENT, origin: "agent" });
	await Bun.sleep(300);
	expect(find(host.tree("screen:monitored"), (n) => n.type === "card" && n.id === run.id)).toBeDefined();
	expect(find(host.tree("screen:monitored", AGENT), (n) => n.type === "card" && n.id === run.id)).toBeUndefined();
});

test("navigation comes only from events, to whoever sent them", async () => {
	const a = fakeItem("a", "1.0.0", "1.0.1");
	const { host, engine } = await start([a]);
	await host.open("quick");
	const r = await host.event("quick", "review", { rowId: a.id });
	expect(r.navigations).toEqual([{ screen: "monitored", select: a.id }]);
	await host.event("screen:monitored", "check", { rowId: a.id }, { instance: AGENT, origin: "agent" });
	await until(() => engine.active().length === 0);
	// The run's card is on the screen the agent used: Show goes there.
	const shown = await host.event("toast", "show-run", { run: engine.runs.at(-1)!.id });
	expect(shown.navigations).toEqual([{ screen: "monitored" }]);
	expect(host.messages.filter((m) => m.type === "navigate").every((m) => m.type === "navigate" && !!m.event)).toBe(true);
});
