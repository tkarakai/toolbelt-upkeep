// Globally installed packages: npm, uv tools, pipx, cargo. Versions from each registry; notes
// from the package's GitHub repository.
import { tilde, which } from "../lib/exec";
import { githubNotes, githubRepo } from "../lib/notes";
import { clean } from "../lib/version";
import type { Candidate, Ctx, Item, Note, Plan, Provider } from "../lib/types";
import { useGh } from "./shared";

const notesFrom = (item: Item, from: string, to: string, ctx: Ctx): Promise<Note[]> => (item.data.repo ? githubNotes(item.data.repo, from, to, ctx, { useGh: useGh() }) : Promise.resolve([]));

// ── npm ──────────────────────────────────────────────────────────────────
const npm = () => which("npm");
const npmUrl = (name: string) => `https://registry.npmjs.org/${name.replace("/", "%2F")}`;

/** `npm ls -g --json --depth=0` → name, version. */
export const parseNpmLs = (json: string) => Object.entries((JSON.parse(json).dependencies ?? {}) as Record<string, { version?: string }>).flatMap(([name, d]) => (d.version ? [{ name, version: d.version }] : []));

export const npmProvider: Provider = {
	id: "npm",
	label: "npm (global)",
	serial: true,
	available: async () => !!npm(),
	async discover(ctx) {
		const n = npm()!;
		// npm exits 1 when it finds problems but still prints the tree
		const r = await ctx.run([n, "ls", "-g", "--json", "--depth=0"], { timeoutMs: 60_000 });
		return parseNpmLs(r.out || "{}").map(
			(p): Candidate => ({ id: `npm:${p.name}`, provider: "npm", ref: p.name, name: p.name, kind: "package", identity: `npm:${p.name}`, installed: p.version, location: `npm -g · ${tilde(n)}`, data: { name: p.name, npm: n } }),
		);
	},
	async check(item, ctx) {
		const r = await ctx.run([item.data.npm, "ls", "-g", "--json", "--depth=0", item.data.name], { timeoutMs: 60_000 });
		const installed = parseNpmLs(r.out || "{}").find((p) => p.name === item.data.name)?.version;
		if (!installed) return { blocked: "Not installed globally any more (or under a different Node)" };
		const meta = await ctx.json<{ version: string; repository?: { url?: string } | string; homepage?: string }>(`${npmUrl(item.data.name)}/latest`);
		const repo = githubRepo(typeof meta.repository === "string" ? meta.repository : meta.repository?.url) ?? githubRepo(meta.homepage);
		if (repo) item.data.repo = repo;
		return { installed, latest: meta.version, homepage: meta.homepage };
	},
	notes: notesFrom,
	plan: async (item, target): Promise<Plan> => ({ steps: [{ argv: [item.data.npm, "install", "-g", `${item.data.name}@${target}`], timeoutMs: 15 * 60_000 }], warnings: item.data.npm.includes(".nvm") ? ["Installs into the Node version nvm uses by default."] : [] }),
	recipe: (item) => ({ check: `npm ls -g ${item.data.name}; registry.npmjs.org`, update: `npm install -g ${item.data.name}@<version>` }),
};

// ── PyPI (uv tools, pipx) ────────────────────────────────────────────────
async function pypi(name: string, ctx: Ctx) {
	const d = await ctx.json<{ info: { version: string; project_urls?: Record<string, string>; home_page?: string } }>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
	const urls = Object.values(d.info.project_urls ?? {}).concat(d.info.home_page ?? []);
	return { version: d.info.version, repo: urls.map(githubRepo).find(Boolean) ?? undefined };
}

/** `uv tool list`: "name v1.2.3" lines, executables indented with "- ". */
export const parseUvTools = (out: string) => out.split("\n").flatMap((l) => {
	const m = l.match(/^([A-Za-z0-9][\w.-]*) v(\S+)/);
	return m ? [{ name: m[1], version: m[2] }] : [];
});

const uv = () => which("uv");
export const uvToolProvider: Provider = {
	id: "uv-tool",
	label: "uv tools",
	serial: true,
	available: async () => !!uv(),
	async discover(ctx) {
		const u = uv()!;
		return parseUvTools((await ctx.run([u, "tool", "list"], { timeoutMs: 30_000 })).out).map((t): Candidate => ({ id: `uv-tool:${t.name}`, provider: "uv-tool", ref: t.name, name: t.name, kind: "package", identity: `py:${t.name}`, installed: t.version, location: "uv tool", data: { name: t.name, uv: u } }));
	},
	async check(item, ctx) {
		const installed = parseUvTools((await ctx.run([item.data.uv, "tool", "list"], { timeoutMs: 30_000 })).out).find((t) => t.name === item.data.name)?.version;
		if (!installed) return { blocked: "Not installed as a uv tool any more" };
		const p = await pypi(item.data.name, ctx);
		if (p.repo) item.data.repo = p.repo;
		return { installed, latest: p.version };
	},
	notes: notesFrom,
	plan: async (item) => ({ steps: [{ argv: [item.data.uv, "tool", "upgrade", item.data.name], timeoutMs: 15 * 60_000 }], warnings: [] }),
	recipe: (item) => ({ check: "uv tool list; pypi.org", update: `uv tool upgrade ${item.data.name}` }),
};

const pipx = () => which("pipx");
type PipxList = { venvs: Record<string, { metadata: { main_package: { package: string; package_version: string } } }> };
/** `pipx list --json` (it exits 1 when nothing is installed, but still prints the JSON). */
async function pipxList(pipx: string, ctx: Ctx): Promise<PipxList> {
	const r = await ctx.run([pipx, "list", "--json"], { timeoutMs: 30_000 });
	try {
		return JSON.parse(r.out) as PipxList;
	} catch {
		throw new Error(`pipx list --json: ${(r.err || r.out).trim().split("\n").at(-1) || `exit ${r.code}`}`);
	}
}

export const pipxProvider: Provider = {
	id: "pipx",
	label: "pipx",
	serial: true,
	available: async () => !!pipx(),
	async discover(ctx) {
		const p = pipx()!;
		const d = await pipxList(p, ctx);
		return Object.values(d.venvs).map(({ metadata: { main_package: m } }): Candidate => ({ id: `pipx:${m.package}`, provider: "pipx", ref: m.package, name: m.package, kind: "package", identity: `py:${m.package}`, installed: m.package_version, location: "pipx", data: { name: m.package, pipx: p } }));
	},
	async check(item, ctx) {
		const d = await pipxList(item.data.pipx, ctx);
		const installed = Object.values(d.venvs).find((v) => v.metadata.main_package.package === item.data.name)?.metadata.main_package.package_version;
		if (!installed) return { blocked: "Not installed with pipx any more" };
		const p = await pypi(item.data.name, ctx);
		if (p.repo) item.data.repo = p.repo;
		return { installed, latest: p.version };
	},
	notes: notesFrom,
	plan: async (item) => ({ steps: [{ argv: [item.data.pipx, "upgrade", item.data.name], timeoutMs: 15 * 60_000 }], warnings: [] }),
	recipe: (item) => ({ check: "pipx list --json; pypi.org", update: `pipx upgrade ${item.data.name}` }),
};

// ── cargo install ────────────────────────────────────────────────────────
/** `cargo install --list`: "name v1.2.3:" (registry installs; path/git ones are skipped). */
export const parseCargoList = (out: string) => out.split("\n").flatMap((l) => {
	const m = l.match(/^(\S+) v(\S+?)(?: \((.*)\))?:$/);
	return m && !m[3] ? [{ name: m[1], version: m[2] }] : [];
});

const cargo = () => which("cargo");
export const cargoProvider: Provider = {
	id: "cargo",
	label: "cargo install",
	serial: true,
	available: async () => !!cargo(),
	async discover(ctx) {
		const c = cargo()!;
		return parseCargoList(await ctx.output([c, "install", "--list"])).map((t): Candidate => ({ id: `cargo:${t.name}`, provider: "cargo", ref: t.name, name: t.name, kind: "package", identity: `crate:${t.name}`, installed: t.version, location: "cargo install", data: { name: t.name, cargo: c } }));
	},
	async check(item, ctx) {
		const installed = parseCargoList(await ctx.output([item.data.cargo, "install", "--list"])).find((t) => t.name === item.data.name)?.version;
		if (!installed) return { blocked: "Not installed with cargo any more" };
		const d = await ctx.json<{ crate: { max_stable_version: string; repository?: string } }>(`https://crates.io/api/v1/crates/${encodeURIComponent(item.data.name)}`);
		const repo = githubRepo(d.crate.repository);
		if (repo) item.data.repo = repo;
		return { installed, latest: clean(d.crate.max_stable_version) };
	},
	notes: notesFrom,
	plan: async (item, target) => ({ steps: [{ argv: [item.data.cargo, "install", item.data.name, "--version", target], timeoutMs: 30 * 60_000 }], warnings: ["Builds from source; this can take a while."] }),
	recipe: (item) => ({ check: "cargo install --list; crates.io", update: `cargo install ${item.data.name} --version <version>` }),
};
