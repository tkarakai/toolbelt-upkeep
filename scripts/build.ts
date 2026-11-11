#!/usr/bin/env bun
// Build ready-to-run packages. Never writes into an installed Toolbelt profile.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { parsePackageManifest } from "@toolbelt/sdk/package";

if (process.argv.includes("--install"))
  throw new Error(
    "Direct installation is removed. Open the built archive in the isolated Toolbelt Plugin Tester.",
  );
const out = resolve("dist/upkeep");
rmSync("dist", { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const source = JSON.parse(readFileSync("toolbelt.json", "utf8"));
const manifest = parsePackageManifest({ ...source, entry: "index.js" });
for (const [entry, name] of [
  [source.entry, "index.js"],
  ["migrate.ts", "migrate.js"],
]) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    packages: "bundle",
  });
  if (!result.success || result.outputs.length !== 1)
    throw new Error(result.logs.join("\n") || "Unexpected bundle outputs");
  await Bun.write(join(out, name), result.outputs[0]);
}
writeFileSync(
  join(out, "toolbelt.json"),
  JSON.stringify(manifest, null, "\t") + "\n",
);
copyFileSync("NOTICE", join(out, "NOTICE"));

import { packagePlugin } from "@toolbelt/sdk/release";
if (!process.argv.includes("--folder-only"))
  await packagePlugin(out, "dist", "0.1.0");
