// Recipes you write: a command that prints the installed version, one that prints the newest
// version, and the update command. They run in a shell, so they're treated as unverified: shown
// in full, run only after you reviewed that exact text, and never updated automatically.
import { createHash } from "node:crypto";
import { githubNotes, githubRepo } from "../lib/notes";
import { clean } from "../lib/version";
import type { Candidate, Ctx, Item, Plan, Provider } from "../lib/types";
import { useGh } from "./shared";

export type Recipe = { name: string; version: string; latest: string; update: string; repo?: string };

/** The fingerprint of a recipe's commands; editing any of them makes it unreviewed again. */
export const recipeHash = (d: Record<string, string>) => createHash("sha256").update(JSON.stringify([d.version, d.latest, d.update])).digest("hex").slice(0, 16);

export function customCandidate(r: Recipe): Candidate {
	const id = `custom:${r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	const repo = githubRepo(r.repo) ?? r.repo?.match(/^[\w.-]+\/[\w.-]+$/)?.[0];
	return { id, provider: "custom", ref: id, name: r.name, kind: "custom", identity: id, data: { version: r.version, latest: r.latest, update: r.update, ...(repo && { repo }) } };
}

const SHELL = "/bin/zsh";
/** The first version-looking token a command printed. */
const versionOf = (out: string) => {
	const m = out.match(/\d+(?:\.\d+)+(?:[-.+][0-9A-Za-z.]+)?/);
	return m ? clean(m[0]) : out.trim().split("\n")[0]?.slice(0, 40);
};

function guard(item: Item) {
	if (item.reviewed !== recipeHash(item.data)) throw new Error("This recipe changed since you reviewed it: review it again before it runs.");
}

export const customProvider: Provider = {
	id: "custom",
	label: "Custom recipes",
	available: async () => true,
	discover: async () => [],
	async check(item, ctx: Ctx) {
		guard(item);
		const installed = versionOf(await ctx.output([SHELL, "-c", item.data.version], { timeoutMs: 60_000 }));
		const latest = versionOf(await ctx.output([SHELL, "-c", item.data.latest], { timeoutMs: 60_000 }));
		return { installed, latest };
	},
	notes: (item, from, to, ctx) => (item.data.repo ? githubNotes(item.data.repo, from, to, ctx, { useGh: useGh() }) : Promise.resolve([])),
	async plan(item): Promise<Plan> {
		guard(item);
		return {
			steps: [{ argv: [SHELL, "-c", item.data.update], label: item.data.update, timeoutMs: 30 * 60_000 }],
			unverified: true,
			warnings: ["This is your own command, run in a shell. Upkeep can't vouch for it: read it before you run it."],
		};
	},
	recipe: (item) => ({ check: `installed: ${item.data.version}\nnewest: ${item.data.latest}`, update: item.data.update }),
};
