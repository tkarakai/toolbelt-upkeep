import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { parsePackageManifest } from "@toolbelt/sdk/package";
import { validateMessage } from "@toolbelt/sdk/validation";
import { customCandidate } from "../providers/custom";

const root = mkdtempSync(join(tmpdir(), "upkeep-package-"));
const unpacked = join(root, "package");
const data = join(root, "data");
let child: ReturnType<typeof Bun.spawn> | undefined;
let messages: any[] = [];
let trees = new Map<string, any>();
const env = { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/usr/bin/true", TOOLBELT_PLUGIN: "upkeep", TOOLBELT_DATA_DIR: data, TOOLBELT_PACKAGE_ROOT: unpacked, TOOLBELT_PLUGIN_VERSION: "0.0.1" };

async function until(check: () => boolean, ms = 5000) {
 const end = Date.now() + ms;
 while (!check()) {
  if (Date.now() > end) throw new Error("Timed out waiting for package; messages: " + JSON.stringify(messages).slice(-1500));
  await Bun.sleep(10);
 }
}
const send = (message: unknown) => { if (!child || typeof child.stdin === "number" || !child.stdin) throw new Error("not running"); child.stdin.write(JSON.stringify(message) + "\n"); };
async function launch() {
 messages = []; trees = new Map();
 child = Bun.spawn([process.execPath, join(unpacked, "index.js")], { cwd: unpacked, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
 const processChild = child;
 void (async () => {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of processChild.stdout as ReadableStream<Uint8Array>) {
   buffer += decoder.decode(chunk, { stream: true });
   let n: number;
   while ((n = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
    if (!line) continue;
    const m = JSON.parse(line); validateMessage(m); messages.push(m);
    if (m.type === "render") trees.set(m.surface, m.tree);
   }
  }
 })();
 send({ type: "hello", protocol: 1, plugin: { id: "upkeep" }, host: { name: "contract-test", version: "0.1.0" } });
 await until(() => messages.some((m) => m.type === "ready"));
 for (const surface of ["monitored", "discover", "queue", "activity", "settings"].map((s) => `screen:${s}`).concat("quick")) send({ type: "open", surface });
 await until(() => trees.size === 6);
}
async function stop() {
 if (!child) return;
 const p = child; child = undefined;
 if (p.exitCode === null) {
  if (p.stdin && typeof p.stdin !== "number") p.stdin.end();
  const exited = await Promise.race([p.exited.then(() => true), Bun.sleep(1000).then(() => false)]);
  if (!exited) p.kill();
 }
 await p.exited;
}
const event = (surface: string, name: string, payload?: unknown) => send({ type: "event", surface, name, payload });

beforeAll(async () => {
 const build = Bun.spawn([process.execPath, "run", "build"], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
 if (await build.exited !== 0) throw new Error(await new Response(build.stderr).text());
 const descriptor = JSON.parse(readFileSync(resolve(import.meta.dir, "../dist/toolbelt-release.json"), "utf8"));
 expect(descriptor.repo).toBe("tkarakai/toolbelt-upkeep");
 const candidate = descriptor.packages.find((p: any) => p.target === `darwin-${process.arch}`)!;
 const archive = resolve(import.meta.dir, "../dist", candidate.asset);
 const bytes = readFileSync(archive);
 expect(createHash("sha256").update(bytes).digest("hex")).toBe(candidate.sha256);
 expect(bytes.byteLength).toBe(candidate.size);
 mkdirSync(unpacked); mkdirSync(data);
 const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", unpacked]);
 expect(tar.exitCode).toBe(0);
 const manifest = parsePackageManifest(JSON.parse(readFileSync(join(unpacked, "toolbelt.json"), "utf8")));
 expect(manifest.id).toBe("upkeep");
 expect(existsSync(join(unpacked, "node_modules"))).toBe(false);
});
afterAll(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });

test("clean release archive: all screens, opt-in, reversible Discover, scratch update, logs and restart", async () => {
 await launch();
 expect(messages.find((m) => m.type === "hello")).toMatchObject({ protocol: 1, capabilities: expect.arrayContaining(["ui.core", "ui.action-key", "lifecycle"]) });
 expect(JSON.stringify(trees.get("screen:monitored"))).toContain("Nothing watched yet");
 for (const file of ["items.json", "discovered.json", "audit.jsonl"]) expect(existsSync(join(data, file))).toBe(false);
 await stop();
 const candidate = customCandidate({ name: "Discover toggle fixture", version: "/bin/echo 1.0.0", latest: "/bin/echo 1.0.0", update: "/usr/bin/true" });
 writeFileSync(join(data, "discovered.json"), JSON.stringify({ at: Date.now(), candidates: [candidate], errors: {} }));
 await launch();
 const findTable = (node: any): any => node?.type === "table" && node.id === "candidates" ? node : (node?.children ?? []).map(findTable).find(Boolean);
 for (const action of ["monitor", "remove", "monitor", "remove"]) {
  const table = findTable(trees.get("screen:discover"));
  expect(table.rows[0].actions).toEqual([action]);
  expect(table.actions.find((a: any) => a.id === action).confirm).toBeUndefined();
  event("screen:discover", action, { rowId: candidate.id });
  await until(() => findTable(trees.get("screen:discover")).rows[0].actions[0] !== action);
 }
 await stop();
 writeFileSync(join(data, "audit.jsonl"), "");
 await launch();
 const version = join(root, "version"); writeFileSync(version, "1.0.0\n");
 event("screen:settings", "add-recipe");
 const fields = { name: "Integration fixture", version: `/bin/cat '${version}'`, latest: "/bin/echo 1.1.0", update: `/bin/echo 1.1.0 > '${version}'` };
 for (const [field, value] of Object.entries(fields)) event("screen:settings", "field", { form: "recipe", field, value });
 event("screen:settings", "recipe-save");
 const items = () => JSON.parse(readFileSync(join(data, "items.json"), "utf8"));
 await until(() => existsSync(join(data, "items.json")) && items()[0]?.state.latest === "1.1.0");
 expect(items()[0]).toMatchObject({ policy: "notify", state: { installed: "1.0.0", outdated: true } });
 expect(readFileSync(version, "utf8").trim()).toBe("1.0.0");
 event("screen:monitored", "review", { rowId: items()[0].id });
 await until(() => JSON.stringify(trees.get("screen:monitored")).includes("What will run"));
 event("screen:monitored", "update");
 await until(() => items()[0].state.installed === "1.1.0");
 await until(() => JSON.stringify(trees.get("screen:activity")).includes("Updated 1.0.0"));
 expect(readFileSync(version, "utf8").trim()).toBe("1.1.0");
 const audit = readFileSync(join(data, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
 expect(audit.map((a) => a.event)).toEqual(["added", "changed", "check", "started", "update"]);
 expect(readFileSync(join(data, "logs", `${audit.at(-1).job}.log`), "utf8")).toContain("Updated 1.0.0 → 1.1.0");
 await stop(); await launch();
 expect(JSON.stringify(trees.get("screen:monitored"))).toContain("Integration fixture");
 send({ type: "prepare", requestId: "upgrade-fixture", reason: "upgrade" });
 await until(() => messages.some((m) => m.type === "prepared" && m.requestId === "upgrade-fixture"));
 expect(messages.find((m) => m.type === "prepared")).toMatchObject({ ready: true });
 await stop();
}, 15000);

test("packaged prepare refuses an unsafe scratch update and does not interrupt it", async () => {
 await launch();
 const version = join(root, "busy-version"); writeFileSync(version, "1.0.0\n");
 event("screen:settings", "add-recipe");
 const fields = { name: "Busy lifecycle fixture", version: `/bin/cat '${version}'`, latest: "/bin/echo 1.1.0", update: `/bin/sleep 0.5; /bin/echo 1.1.0 > '${version}'` };
 for (const [field, value] of Object.entries(fields)) event("screen:settings", "field", { form: "recipe", field, value });
 event("screen:settings", "recipe-save");
 const item = () => JSON.parse(readFileSync(join(data, "items.json"), "utf8")).find((i: any) => i.name === fields.name);
 await until(() => item()?.state.latest === "1.1.0");
 event("screen:monitored", "review", { rowId: item().id });
 await until(() => JSON.stringify(trees.get("screen:monitored")).includes("What will run"));
 event("screen:monitored", "update");
 send({ type: "prepare", requestId: "busy-upgrade", reason: "upgrade" });
 await until(() => messages.some((m) => m.type === "prepared" && m.requestId === "busy-upgrade"));
 expect(messages.find((m) => m.type === "prepared" && m.requestId === "busy-upgrade")).toMatchObject({ ready: false });
 expect(readFileSync(version, "utf8").trim()).toBe("1.0.0");
 await until(() => item().state.installed === "1.1.0");
 expect(readFileSync(version, "utf8").trim()).toBe("1.1.0");
 send({ type: "prepare", requestId: "finished-upgrade", reason: "upgrade" });
 await until(() => messages.some((m) => m.type === "prepared" && m.requestId === "finished-upgrade"));
 expect(messages.find((m) => m.type === "prepared" && m.requestId === "finished-upgrade")).toMatchObject({ ready: true });
 await stop();
});

test("packaged migration preserves staged data, retries safely and rejects unknown schemas", async () => {
 const marker = join(data, "migration-marker"); writeFileSync(marker, "retain me");
 for (const fromSchema of [null, 1, 1, 2]) {
  const input = { type: "migrate", transactionId: "fixture", fromVersion: fromSchema === null ? null : "0.0.1", toVersion: "0.0.1", fromSchema, toSchema: 1, sourceDir: data, targetDir: data };
  const p = Bun.spawn([process.execPath, join(unpacked, "migrate.js")], { cwd: unpacked, env, stdin: new Response(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(p.stdout).text();
  expect(await p.exited).toBe(fromSchema === 2 ? 1 : 0);
  expect(output).toContain(fromSchema === 2 ? "migration-failed" : "migration-complete");
  expect(readFileSync(marker, "utf8")).toBe("retain me");
 }
});
