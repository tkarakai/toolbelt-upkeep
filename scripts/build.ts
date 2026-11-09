#!/usr/bin/env bun
// Bundles the plugin into dist/upkeep/ (index.js + toolbelt.json), the shape Toolbelt loads.
// --install also copies it to ~/Library/Application Support/Toolbelt/plugins/upkeep/.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const out = "dist/upkeep";
rmSync("dist", { recursive: true, force: true });
const manifest = JSON.parse(readFileSync("toolbelt.json", "utf8"));
const res = await Bun.build({ entrypoints: [manifest.entry], target: "bun" });
if (!res.success) {
	for (const l of res.logs) console.error(l);
	process.exit(1);
}
mkdirSync(out, { recursive: true });
await Bun.write(join(out, "index.js"), res.outputs[0]);
writeFileSync(join(out, "toolbelt.json"), JSON.stringify({ ...manifest, entry: "index.js" }, null, "\t") + "\n");
console.log(`${out}  ${manifest.name} ${manifest.version}`);

if (process.argv.includes("--install")) {
	const dest = join(homedir(), "Library/Application Support/Toolbelt/plugins", manifest.id);
	rmSync(dest, { recursive: true, force: true });
	cpSync(out, dest, { recursive: true });
	console.log(`installed → ${dest} (restart Toolbelt, or the plugin from its page)`);
}
