// Version strings as found in the wild: "v1.2.3", "1.2.3_1" (Homebrew revision), "go1.23.3",
// "bun-v1.4.4", "2.50", "1.0.0-beta.2", "6.4.1 (6410)". Compared segment by segment, numbers
// numerically; a pre-release ("-beta.2", "rc1", "b3") sorts before its release.

const PRE = /^(alpha|a|beta|b|pre|preview|rc|c|dev|nightly|canary|snapshot|insiders)$/i;

/** The version part of a tag or tool output: "bun-v1.4.4" → "1.4.4", "go1.23" → "1.23". */
export function clean(v: string): string {
	const m = v.trim().match(/\d+(?:\.\d+)*(?:[-_+.]?[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?/);
	return m ? m[0] : v.trim();
}

type Seg = { n: number[]; pre: (string | number)[] };

function parse(v: string): Seg {
	const s = clean(v).replace(/\+.*$/, ""); // build metadata doesn't order
	const m = s.match(/^(\d+(?:\.\d+)*)(.*)$/);
	if (!m) return { n: [], pre: [s] };
	const n = m[1].split(".").map(Number);
	let rest = m[2];
	// Homebrew's "_1" revision counts as a further numeric segment.
	const rev = rest.match(/^_(\d+)$/);
	if (rev) return { n: [...n, 0, Number(rev[1])], pre: [] };
	rest = rest.replace(/^[-.]/, "");
	if (!rest) return { n, pre: [] };
	const pre = rest
		.split(/[.\-_]|(?<=\D)(?=\d)|(?<=\d)(?=\D)/)
		.filter(Boolean)
		.map((p) => (/^\d+$/.test(p) ? Number(p) : p.toLowerCase()));
	return { n, pre };
}

export function isPrerelease(v: string): boolean {
	const { pre } = parse(v);
	return pre.some((p) => typeof p === "string" && PRE.test(p));
}

/** < 0 when a is older than b, 0 when equal, > 0 when newer. */
export function compare(a: string, b: string): number {
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < Math.max(x.n.length, y.n.length); i++) {
		const d = (x.n[i] ?? 0) - (y.n[i] ?? 0);
		if (d) return Math.sign(d);
	}
	// A release beats its pre-releases.
	if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		if (typeof p === "number" && typeof q === "number") return Math.sign(p - q);
		if (typeof p === "number") return -1;
		if (typeof q === "number") return 1;
		return p < q ? -1 : 1;
	}
	return 0;
}

export const newer = (a: string, b: string) => compare(a, b) > 0;

export type Change = "major" | "minor" | "patch" | "none";

/** How big a step from `from` to `to` is. Versions "0.x" treat the minor as the major. */
export function change(from: string, to: string): Change {
	if (compare(to, from) <= 0) return "none";
	const a = parse(from).n;
	const b = parse(to).n;
	if ((a[0] ?? 0) !== (b[0] ?? 0)) return "major";
	if ((a[0] ?? 0) === 0 && (a[1] ?? 0) !== (b[1] ?? 0)) return "major";
	if ((a[1] ?? 0) !== (b[1] ?? 0)) return "minor";
	return "patch";
}

/** Does a policy allow taking this step automatically? */
export function policyAllows(policy: "notify" | "patch" | "minor" | "all", step: Change): boolean {
	if (step === "none" || policy === "notify") return false;
	if (policy === "all") return true;
	if (policy === "minor") return step !== "major";
	return step === "patch";
}
