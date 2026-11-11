import {
  json,
  packagePlugin,
  run,
  updateJSONVersion,
  type ReleaseConfig,
} from "@toolbelt/sdk/release";
export default {
  repo: "tkarakai/toolbelt-upkeep",
  hostVersion: "0.1.0",
  products: {
    plugin: {
      changelog: "CHANGELOG.md",
      version: () => json("toolbelt.json").version,
      async setVersion(v) {
        await updateJSONVersion("package.json", v);
        await updateJSONVersion("toolbelt.json", v);
      },
      async build() {
        await run(["bun", "scripts/build.ts", "--folder-only"]);
        return packagePlugin("dist/upkeep", "dist", "0.1.0", []);
      },
    },
  },
} satisfies ReleaseConfig;
