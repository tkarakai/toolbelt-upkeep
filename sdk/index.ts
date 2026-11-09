// Vendored from tkarakai/toolbelt@1f8cf57: src/sdk/index.ts. Don't edit here — run scripts/sync-sdk.ts.
// The plugin side of the Toolbelt protocol (to become `@toolbelt/sdk`).
//
//   import { definePlugin } from "../../src/sdk";
//   definePlugin({
//     render: { "screen:main": () => ({ type: "text", text: "hello" }) },
//     onEvent: (surface, name, payload, ctx) => { … ctx.invalidate(); },
//   });
//
// `render` functions are called for surfaces that are open, whenever `ctx.invalidate()` is
// called. Unchanged trees aren't sent again.
import { PROTOCOL_VERSION, splitLines, type HostMessage, type Node, type PluginMessage } from "./protocol";

export type { Node, Cell, Column, Row, Action, Field, Tone, EventPayloads, Dialog, LogLine } from "./protocol";
export { duration, relative } from "./time";

/** This plugin's own folder for data (settings, state, logs). Toolbelt creates it. */
export function dataDir(): string {
	return process.env.TOOLBELT_DATA_DIR ?? `${process.env.TMPDIR ?? "/tmp"}/toolbelt-data/${process.env.TOOLBELT_PLUGIN ?? "plugin"}`;
}

export type Context = {
	/** Re-render open surfaces (all, or the ones named). */
	invalidate(...surfaces: string[]): void;
	badge(value: number | string | null): void;
	toast(text: string, tone?: "default" | "success" | "error"): void;
	/** Surfaces the host currently shows. */
	readonly open: ReadonlySet<string>;
};

export type PluginDefinition = {
	/** Surface → its UI. Surfaces: `screen:<id>` and `quick`. */
	render: Record<string, (ctx: Context) => Node | Promise<Node>>;
	onEvent?: (surface: string, name: string, payload: any, ctx: Context) => void | Promise<void>;
	/** Called once after the host said hello. */
	start?: (ctx: Context) => void | Promise<void>;
	onOpen?: (surface: string, ctx: Context) => void;
	onClose?: (surface: string, ctx: Context) => void;
};

export function definePlugin(def: PluginDefinition, io: { write?: (line: string) => void; input?: AsyncIterable<Uint8Array> } = {}) {
	const write = io.write ?? ((line: string) => void process.stdout.write(line));
	const send = (m: PluginMessage) => write(JSON.stringify(m) + "\n");
	const open = new Set<string>();
	const last = new Map<string, string>();
	let pending: Set<string> | "all" | null = null;

	const flush = async () => {
		const which = pending === "all" ? [...open] : [...(pending ?? [])].filter((s) => open.has(s));
		pending = null;
		for (const surface of which) {
			const fn = def.render[surface];
			if (!fn) continue;
			let tree: Node;
			try {
				tree = await fn(ctx);
			} catch (e) {
				tree = { type: "empty", icon: "triangle-alert", title: "This view failed to render", description: String((e as Error)?.message ?? e) };
			}
			const json = JSON.stringify(tree);
			if (last.get(surface) === json) continue;
			last.set(surface, json);
			write(`{"type":"render","surface":${JSON.stringify(surface)},"tree":${json}}\n`);
		}
	};

	const ctx: Context = {
		invalidate(...surfaces) {
			const wasIdle = pending === null;
			if (surfaces.length === 0 || pending === "all") pending = "all";
			else {
				pending ??= new Set();
				for (const s of surfaces) pending.add(s);
			}
			// Coalesce bursts of invalidations into one render pass.
			if (wasIdle) queueMicrotask(() => void flush());
		},
		badge: (value) => send({ type: "badge", value }),
		toast: (text, tone) => send({ type: "toast", text, tone }),
		open,
	};

	const handle = async (msg: HostMessage) => {
		switch (msg.type) {
			case "hello":
				if (msg.protocol !== PROTOCOL_VERSION) console.error(`toolbelt sdk: host speaks protocol ${msg.protocol}, this plugin ${PROTOCOL_VERSION}`);
				await def.start?.(ctx);
				break;
			case "open":
				open.add(msg.surface);
				last.delete(msg.surface); // a new viewer needs the full tree
				def.onOpen?.(msg.surface, ctx);
				ctx.invalidate(msg.surface);
				break;
			case "close":
				open.delete(msg.surface);
				def.onClose?.(msg.surface, ctx);
				break;
			case "event":
				await def.onEvent?.(msg.surface, msg.name, msg.payload, ctx);
				break;
		}
	};

	const input = io.input ?? Bun.stdin.stream();
	(async () => {
		const decoder = new TextDecoder();
		let buf = "";
		for await (const chunk of input) {
			const { lines, rest } = splitLines(buf + decoder.decode(chunk, { stream: true }));
			buf = rest;
			for (const line of lines) {
				let msg: HostMessage;
				try {
					msg = JSON.parse(line);
				} catch {
					console.error("toolbelt sdk: bad JSON from host");
					continue;
				}
				await handle(msg).catch((e) => console.error("toolbelt sdk:", e));
			}
		}
		// The host closed our stdin: Toolbelt quit or stopped us.
		if (!io.input) process.exit(0);
	})();

	return ctx;
}
