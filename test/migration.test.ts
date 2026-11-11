import { expect, test } from "bun:test";
import { validateMigration } from "../lib/migration";

test("schema 1 initialization and unchanged-schema upgrade are explicit no-ops", () => {
	expect(() => validateMigration(null, 1)).not.toThrow();
	expect(() => validateMigration(1, 1)).not.toThrow();
});

test("an incompatible schema cannot be silently upgraded or downgraded", () => {
	for (const [from, to] of [[2, 1], [1, 2], [0, 1], [null, 2]]) {
		expect(() => validateMigration(from, to!)).toThrow("Unsupported Upkeep data migration");
	}
});
