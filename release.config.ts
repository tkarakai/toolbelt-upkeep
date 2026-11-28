import {
  json,
  packagePlugin,
  run,
  updateJSONVersion,
  type ReleaseConfig,
} from "@toolbelt/sdk/release";
export default {
  repo: "tkarakai/toolbelt-upkeep",
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
        return packagePlugin("dist/upkeep", "dist");
      },
    },
  },
} satisfies ReleaseConfig;
