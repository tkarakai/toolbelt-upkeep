// Running commands: always argument lists (no shell, except custom recipes, which say so),
// input closed so nothing can wait for a typed answer, output streamed line by line, a
// timeout, and cancellation.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const home = homedir();
export const tilde = (p: string) => (p.startsWith(home) ? "~" + p.slice(home.length) : p);

export type Line = { text: string; stream: "out" | "err" };
export type RunOptions = {
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	signal?: AbortSignal;
	onLine?: (line: Line) => void;
};
export type Result = { code: number; out: string; err: string; timedOut: boolean; cancelled: boolean };

// Toolbelt started from Finder has a minimal PATH; tools live in the login shell's PATH.
let loginPath: string | null = null;
const EXTRA = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.cargo/bin`, `${home}/.bun/bin`, `${home}/.deno/bin`, "/usr/local/go/bin"];

/** Read the login shell's PATH once (with a timeout), plus the usual tool folders. */
export async function initPath(): Promise<string> {
	if (loginPath !== null) return loginPath;
	const shell = process.env.SHELL || "/bin/zsh";
	let fromShell = "";
	try {
		const p = Bun.spawn([shell, "-ilc", 'printf "__UPKEEP__%s__UPKEEP__" "$PATH"'], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, TERM: "dumb" } });
		const timer = setTimeout(() => p.kill(), 8000);
		const out = await new Response(p.stdout).text();
		clearTimeout(timer);
		fromShell = out.match(/__UPKEEP__(.*?)__UPKEEP__/s)?.[1] ?? "";
	} catch {}
	const parts = [...fromShell.split(":"), ...(process.env.PATH ?? "").split(":"), ...EXTRA, "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	loginPath = [...new Set(parts.filter((p) => p && existsSync(p)))].join(":");
	return loginPath;
}

export const pathNow = () => loginPath ?? process.env.PATH ?? "/usr/bin:/bin";

/** Full path of a command on the login PATH, or null. */
export function which(cmd: string): string | null {
	if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
	for (const dir of pathNow().split(":")) {
		const p = join(dir, cmd);
		if (existsSync(p)) return p;
	}
	return null;
}

/** Every copy of a command on the PATH (to show duplicates). */
export function whichAll(cmd: string): string[] {
	return pathNow()
		.split(":")
		.map((d) => join(d, cmd))
		.filter((p, i, all) => existsSync(p) && all.indexOf(p) === i);
}

/**
 * The environment every command gets: the login PATH, no prompts (git, Homebrew, ssh), and no
 * password helper unless the caller adds one.
 */
export function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		PATH: pathNow(),
		HOMEBREW_NO_AUTO_UPDATE: "1",
		HOMEBREW_NO_ENV_HINTS: "1",
		NONINTERACTIVE: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
		NO_COLOR: "1",
		TERM: "dumb",
		SUDO_ASKPASS: undefined,
		...extra,
	};
	for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
	return env;
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<Result> {
	const proc = Bun.spawn(argv, { cwd: opts.cwd, env: (opts.env ?? baseEnv()) as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	let cancelled = false;
	const stop = () => {
		proc.kill("SIGTERM");
		setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 5000);
	};
	const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), stop()), opts.timeoutMs) : undefined;
	const onAbort = () => ((cancelled = true), stop());
	if (opts.signal?.aborted) onAbort();
	opts.signal?.addEventListener("abort", onAbort);
	const read = async (stream: ReadableStream<Uint8Array>, which: "out" | "err") => {
		const decoder = new TextDecoder();
		let all = "";
		let buf = "";
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			all += text;
			buf += text;
			// Progress bars redraw with \r; keep the last state of each line.
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const l of lines) {
				const t = l.split("\r").filter(Boolean).at(-1) ?? "";
				if (t.trim()) opts.onLine?.({ text: t, stream: which });
			}
		}
		const t = buf.split("\r").filter(Boolean).at(-1) ?? "";
		if (t.trim()) opts.onLine?.({ text: t, stream: which });
		return all;
	};
	const [out, err, code] = await Promise.all([read(proc.stdout as ReadableStream<Uint8Array>, "out"), read(proc.stderr as ReadableStream<Uint8Array>, "err"), proc.exited]);
	clearTimeout(timer);
	opts.signal?.removeEventListener("abort", onAbort);
	return { code: code ?? -1, out, err, timedOut, cancelled };
}

/** Run and return stdout, or throw with stderr's last lines. */
export async function output(argv: string[], opts: RunOptions = {}): Promise<string> {
	const r = await run(argv, { timeoutMs: 60_000, ...opts });
	if (r.code !== 0 || r.timedOut) {
		const why = r.timedOut ? "timed out" : (r.err || r.out).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`;
		throw new Error(`${argv.map(quote).join(" ")}: ${why}`);
	}
	return r.out;
}

/** Shell-quote one argument, for showing commands and handing them to Terminal. */
export function quote(a: string): string {
	return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/** A command as you'd type it. */
export const show = (argv: string[]) => argv.map(quote).join(" ");

/** Output that means a command wanted a password it couldn't ask for. */
export const askedForPassword = (text: string) => /a terminal is required|a password is required|no askpass program|sudo: .*password|must be run as root|Password:/i.test(text);
