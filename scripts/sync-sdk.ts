#!/usr/bin/env bun
// Copies Toolbelt's plugin SDK into sdk/ until it's published as a package (@toolbelt/sdk).
// Run: bun scripts/sync-sdk.ts <path to a toolbelt checkout>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: bun scripts/sync-sdk.ts <toolbelt checkout>");
const sha = Bun.spawnSync(["git", "-C", root, "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
const header = (from: string) => `// Vendored from tkarakai/toolbelt@${sha}: ${from}. Don't edit here — run scripts/sync-sdk.ts.\n`;
const files: [string, string][] = [
	["src/sdk/index.ts", "index.ts"],
	["src/shared/protocol.ts", "protocol.ts"],
	["src/shared/time.ts", "time.ts"],
];
for (const [from, to] of files) {
	const text = readFileSync(join(root, from), "utf8").replace(/^\/\/ Vendored from .*\n/, "").replaceAll('"../shared/', '"./');
	writeFileSync(join("sdk", to), header(from) + text);
	console.log(`sdk/${to}  ← ${from}`);
}
