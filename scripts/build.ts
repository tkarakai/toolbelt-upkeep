#!/usr/bin/env bun
// Build ready-to-run packages. Never writes into an installed Toolbelt profile.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { parsePackageManifest } from "@toolbelt/sdk/package";

if (process.argv.includes("--install")) throw new Error("Direct installation is removed. Open the built archive in the isolated Toolbelt Plugin Tester.");
const out = resolve("dist/upkeep");
rmSync("dist", { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const source = JSON.parse(readFileSync("toolbelt.json", "utf8"));
const manifest = parsePackageManifest({ ...source, entry: "index.js" });
for (const [entry, name] of [[source.entry, "index.js"], ["migrate.ts", "migrate.js"]]) {
 const result = await Bun.build({ entrypoints: [entry], target: "bun", packages: "bundle" });
 if (!result.success || result.outputs.length !== 1) throw new Error(result.logs.join("\n") || "Unexpected bundle outputs");
 await Bun.write(join(out, name), result.outputs[0]);
}
writeFileSync(join(out, "toolbelt.json"), JSON.stringify(manifest, null, "\t") + "\n");
copyFileSync("NOTICE", join(out, "NOTICE"));
const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
if (git.exitCode !== 0) throw new Error("Cannot identify source commit");
const commit = git.stdout.toString().trim();
const packages = [];
for (const target of manifest.requires.platforms) {
 const asset = `toolbelt-upkeep-${manifest.version}-${target}.tar.gz`;
 const archive = resolve("dist", asset);
 const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", out, "toolbelt.json", "index.js", "migrate.js", "NOTICE"], { stdout: "pipe", stderr: "pipe" });
 if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
 const bytes = readFileSync(archive);
 const sha256 = createHash("sha256").update(bytes).digest("hex");
 writeFileSync(`${archive}.sha256`, `${sha256}  ${asset}\n`);
 packages.push({ target, asset, sha256, size: bytes.byteLength });
}
writeFileSync("dist/toolbelt-release.json", JSON.stringify({ formatVersion: 1, id: manifest.id, version: manifest.version, repo: manifest.repo, commit, packages }, null, "\t") + "\n");
console.log(`Packaged ${manifest.id} ${manifest.version} (${packages.map((p) => p.target).join(", ")})`);
