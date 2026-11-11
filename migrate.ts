import { defineMigration } from "@toolbelt/sdk";
import { validateMigration } from "./lib/migration";

defineMigration((ctx) => {
	validateMigration(ctx.fromSchema, ctx.toSchema);
	ctx.progress(ctx.fromSchema === null ? "Initialize Upkeep schema 1" : "Upkeep schema 1 is unchanged; staged files are preserved");
});
