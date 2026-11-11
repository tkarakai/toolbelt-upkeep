// Upkeep's files in its data folder: items, settings, discovered candidates (JSON, written
// atomically), the audit log (JSON lines, append-only, rotated) and one log file per job.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, Item } from "./types";

export type Settings = {
	intervalHours: number;
	/** Master switch for automatic updates. Off until you turn it on. */
	autoUpdates: boolean;
	/** Automatic updates only on AC power. */
	acOnly: boolean;
	/** When automatic updates may run. */
	window: "any" | "night";
	/** Folders to look for git clones in, comma-separated, ~ allowed. */
	folders: string;
	/** Use the GitHub CLI (if signed in) for release notes: higher rate limit. */
	useGh: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
	intervalHours: 6,
	autoUpdates: false,
	acOnly: true,
	window: "any",
	folders: "~/dev, ~/code, ~/src, ~/projects, ~/Developer, ~/work",
	useGh: true,
};

export type Tone = "default" | "muted" | "success" | "warning" | "danger" | "info";
export type AuditEntry = {
	at: number;
	/** What happened. */
	event: "added" | "removed" | "changed" | "scan" | "check" | "update" | "rollback" | "skipped" | "cancelled" | "started";
	item?: string;
	name?: string;
	text: string;
	tone: Tone;
	job?: string;
	/** Who started it: you, the schedule, an automatic update. */
	by?: "you" | "schedule" | "auto";
	detail?: Record<string, string>;
};

const AUDIT_MAX = 10 * 1024 * 1024;

export class Store {
	readonly logs: string;
	constructor(readonly dir: string) {
		this.logs = join(dir, "logs");
		mkdirSync(this.logs, { recursive: true });
	}

	private read<T>(name: string, fallback: T): T {
		try {
			return JSON.parse(readFileSync(join(this.dir, name), "utf8")) as T;
		} catch {
			return fallback;
		}
	}

	/** Write to a temporary file, then rename: a crash never leaves half a file. */
	private write(name: string, value: unknown) {
		const file = join(this.dir, name);
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(value, null, "\t") + "\n", { mode: 0o600 });
		renameSync(tmp, file);
	}

	items = () => this.read<Item[]>("items.json", []);
	saveItems = (items: Item[]) => this.write("items.json", items);
	settings = (): Settings => ({ ...DEFAULT_SETTINGS, ...this.read<Partial<Settings>>("settings.json", {}) });
	saveSettings = (s: Settings) => this.write("settings.json", s);
	discovered = () => this.read<{ at: number; candidates: Candidate[]; errors: Record<string, string> } | null>("discovered.json", null);
	saveDiscovered = (d: { at: number; candidates: Candidate[]; errors: Record<string, string> }) => this.write("discovered.json", d);

	audit(entry: AuditEntry) {
		const file = join(this.dir, "audit.jsonl");
		try {
			if (existsSync(file) && statSync(file).size > AUDIT_MAX) renameSync(file, join(this.dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`));
		} catch {}
		appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
	}

	/** The newest `n` audit entries, oldest first. */
	recentAudit(n = 2000): AuditEntry[] {
		try {
			const lines = readFileSync(join(this.dir, "audit.jsonl"), "utf8").trim().split("\n");
			return lines
				.slice(-n)
				.map((l) => {
					try {
						return JSON.parse(l) as AuditEntry;
					} catch {
						return null;
					}
				})
				.filter((e): e is AuditEntry => !!e);
		} catch {
			return [];
		}
	}

	logFile = (job: string) => join(this.logs, `${job}.log`);
	appendLog = (job: string, line: string) => appendFileSync(this.logFile(job), line + "\n", { mode: 0o600 });
	readLog(job: string, maxLines = 400): string[] {
		try {
			return readFileSync(this.logFile(job), "utf8").trimEnd().split("\n").slice(-maxLines);
		} catch {
			return [];
		}
	}
}
