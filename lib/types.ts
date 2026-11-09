// Upkeep's model: providers find things (candidates); the ones you add become items, each with
// its recipe (provider + settings), policy and last results.
import type { Line, RunOptions, Result } from "./exec";

export type Kind = "app" | "runtime" | "package" | "repo" | "custom";
export const KIND_LABEL: Record<Kind, string> = { app: "Apps", runtime: "Runtimes & tools", package: "Packages", repo: "Repositories", custom: "Custom recipes" };

/** Something a provider found (or you described). */
export type Candidate = {
	/** `${provider}:${ref}` — stable across scans. */
	id: string;
	provider: string;
	/** What the provider calls it: formula name, app path, repo path, toolchain… */
	ref: string;
	name: string;
	kind: Kind;
	/** Links copies of the same thing from different installers: "tool:uv", "app:com.fork.Fork". */
	identity: string;
	installed?: string;
	location?: string;
	description?: string;
	/** The provider's settings for this item: its recipe. Strings only, so it's easy to show. */
	data: Record<string, string>;
	/** Shown in Discover: "dependency", "standalone install"… */
	note?: string;
};

export type Policy = "notify" | "patch" | "minor" | "all";
export const POLICY_LABEL: Record<Policy, string> = { notify: "Notify only", patch: "Auto: patches", minor: "Auto: minor + patches", all: "Auto: all updates" };

export type ItemState = {
	installed?: string;
	latest?: string;
	outdated: boolean;
	channel?: string;
	/** A newer version outside the item's channel (a new LTS line, a new major for "same major"). */
	beyond?: string;
	eol?: { at?: string; past: boolean };
	checkedAt?: number;
	nextAt: number;
	checkMs?: number;
	error?: string;
	failures: number;
	/** Why this needs you before it can update ("Has local changes", "Needs your password"). */
	blocked?: string;
	needsAuth?: boolean;
	/** Version before the last update, for rollback. */
	previous?: string;
	updatedAt?: number;
	/** Apps: the code signature's Team ID, to compare after updates. */
	team?: string;
	homepage?: string;
};

export type Item = Candidate & {
	addedAt: number;
	policy: Policy;
	/** Provider-specific channel choice ("major", "lts", "current", "stable", "beta"). */
	channel?: string;
	intervalHours?: number;
	pinned?: boolean;
	/** A version you skipped; newer ones are offered again. */
	skip?: string;
	/** Custom recipes: the hash of the commands you reviewed. */
	reviewed?: string;
	state: ItemState;
};

export type Check = {
	installed?: string;
	latest?: string;
	/** Defaults to latest > installed. Providers that can't compare versions (git) say so. */
	outdated?: boolean;
	channel?: string;
	beyond?: string;
	eol?: { at?: string; past: boolean };
	blocked?: string;
	homepage?: string;
	/** Updating it always needs your password. */
	needsAuth?: boolean;
};

export type Note = { version: string; date?: string; body: string; url?: string };

/** One command. `shell` only for custom recipes (shown as unverified). */
export type Step = { argv: string[]; cwd?: string; label?: string; timeoutMs?: number; env?: Record<string, string> };

export type Plan = {
	steps: Step[];
	/** Needs your password (never attempted unattended). */
	needsAuth?: boolean;
	/** The app that must not be running (quit first, with your OK). */
	app?: { path: string; bundleId?: string; name: string };
	/** Opens the vendor's updater (the app, a download page); Upkeep checks again afterwards. */
	handoff?: string;
	/** Commands you wrote: unverified. */
	unverified?: boolean;
	warnings: string[];
};

export type Ctx = {
	run(argv: string[], opts?: RunOptions): Promise<Result>;
	output(argv: string[], opts?: RunOptions): Promise<string>;
	json<T = any>(url: string, init?: { headers?: Record<string, string> }): Promise<T>;
	text(url: string): Promise<string>;
	log(text: string, tone?: "muted" | "warning" | "danger" | "success"): void;
	signal?: AbortSignal;
	onLine?: (l: Line) => void;
};

export interface Provider {
	id: string;
	label: string;
	/** Runs one job at a time (a shared lock like Homebrew's). */
	serial?: boolean;
	/** Is the tool behind this provider installed? */
	available(): Promise<boolean>;
	discover(ctx: Ctx): Promise<Candidate[]>;
	check(item: Item, ctx: Ctx): Promise<Check>;
	/** Release notes for versions after `from`, up to and including `to`, newest first. */
	notes?(item: Item, from: string, to: string, ctx: Ctx): Promise<Note[]>;
	plan(item: Item, target: string, ctx: Ctx): Promise<Plan>;
	rollback?(item: Item, to: string): Plan | null;
	/** How it checks and updates, in words and commands, for the details panel. */
	recipe(item: Item): { check: string; update: string };
	/** Channels the person can choose, if any. */
	channels?(item: Item): { value: string; label: string }[];
}
