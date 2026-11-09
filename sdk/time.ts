// Vendored from tkarakai/toolbelt@1f8cf57: src/shared/time.ts. Don't edit here — run scripts/sync-sdk.ts.
// How Toolbelt shows a moment (`at`, epoch ms) relative to now: "in 2h 14m", "5m ago".
// Shared by the renderer and plugins that want the same wording in plain text.

/** "2h 14m", "45s", "3d 4h": the two largest units. */
export function duration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
	const d = Math.floor(h / 24);
	return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "in 2h 14m", "5m ago", "just now"; past a week, the date. */
export function relative(at: number, now = Date.now()): string {
	const diff = at - now;
	if (Math.abs(diff) < 5_000) return diff > 0 ? "in a moment" : "just now";
	if (Math.abs(diff) > 7 * 86_400_000) return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
	return diff > 0 ? `in ${duration(diff)}` : `${duration(-diff)} ago`;
}

/** How often a relative time needs redrawing to stay right. */
export const refreshEvery = (at: number, now = Date.now()) => (Math.abs(at - now) < 3_600_000 ? 1_000 : 30_000);
