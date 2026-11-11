import { describe, expect, test } from "bun:test";
import { change, clean, compare, isPrerelease, policyAllows } from "../lib/version";

describe("clean", () => {
	test("finds the version in tags and tool output", () => {
		expect(clean("v24.21.0")).toBe("24.21.0");
		expect(clean("bun-v1.4.4")).toBe("1.4.4");
		expect(clean("go1.23.3")).toBe("1.23.3");
		expect(clean("uv 0.12.1 (329541a50 2026-07-31 aarch64-apple-darwin)")).toBe("0.12.1");
		expect(clean("2.1.321 (Claude Code)")).toBe("2.1.321");
		expect(clean("deno 2.5.4 (stable, release, aarch64-apple-darwin)")).toBe("2.5.4");
		expect(clean("1.0.0-beta.2")).toBe("1.0.0-beta.2");
	});
});

describe("compare", () => {
	test("numbers, not strings", () => {
		expect(compare("1.10.0", "1.9.9")).toBe(1);
		expect(compare("2.50", "2.6")).toBe(1);
		expect(compare("1.2", "1.2.0")).toBe(0);
		expect(compare("v1.2.3", "1.2.3")).toBe(0);
	});
	test("Homebrew revisions come after the plain version", () => {
		expect(compare("4.0.0_1", "4.0.0")).toBe(1);
		expect(compare("4.0.0_2", "4.0.0_1")).toBe(1);
		expect(compare("4.0.1", "4.0.0_3")).toBe(1);
	});
	test("pre-releases come before their release", () => {
		expect(compare("1.0.0-beta.2", "1.0.0")).toBe(-1);
		expect(compare("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
		expect(compare("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
		expect(compare("1.0.0-rc1", "0.9.9")).toBe(1);
	});
});

test("pre-release detection", () => {
	expect(isPrerelease("1.0.0-beta.2")).toBe(true);
	expect(isPrerelease("6.4rc1")).toBe(true);
	expect(isPrerelease("1.4.0-nightly")).toBe(true);
	expect(isPrerelease("1.4.0")).toBe(false);
	expect(isPrerelease("4.0.0_1")).toBe(false);
});

test("the size of a step; 0.x treats the minor as major", () => {
	expect(change("1.2.3", "1.2.4")).toBe("patch");
	expect(change("1.2.3", "1.3.0")).toBe("minor");
	expect(change("1.2.3", "2.0.0")).toBe("major");
	expect(change("0.12.1", "0.13.7")).toBe("major");
	expect(change("0.12.1", "0.12.7")).toBe("patch");
	expect(change("1.2.3", "1.2.3")).toBe("none");
	expect(change("1.2.3", "1.2.2")).toBe("none");
});

test("policies", () => {
	expect(policyAllows("notify", "patch")).toBe(false);
	expect(policyAllows("patch", "patch")).toBe(true);
	expect(policyAllows("patch", "minor")).toBe(false);
	expect(policyAllows("minor", "minor")).toBe(true);
	expect(policyAllows("minor", "major")).toBe(false);
	expect(policyAllows("all", "major")).toBe(true);
	expect(policyAllows("all", "none")).toBe(false);
});
