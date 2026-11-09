// Vendored from tkarakai/toolbelt@1f8cf57: src/shared/protocol.ts. Don't edit here — run scripts/sync-sdk.ts.
// The Toolbelt plugin protocol, version 0 (the spike).
//
// A plugin is a program Toolbelt starts with Bun. They talk JSON, one object per line:
// the host writes to the plugin's stdin, the plugin writes to its stdout (stderr is its log).
//
//   host → plugin   {"type":"hello", …}            once, right after start
//                   {"type":"open","surface":"…"}  a surface became visible: render it
//                   {"type":"close","surface":"…"} it's hidden: stop rendering it
//                   {"type":"event", …}            the person did something on a surface
//   plugin → host   {"type":"render","surface":"…","tree":{…}}  the surface's whole UI tree
//                   {"type":"badge","value":…}     the count next to the plugin's name
//                   {"type":"toast", …}            a short notification in the window
//
// Surfaces are `screen:<id>` (a tab in the window) and `quick` (the menu bar quick view).
// The plugin describes *what* to show with the nodes below; Toolbelt decides *how* — every
// node maps to shadcn/ui components, so all plugins look like one app. UI state that has to
// feel instant (typing, selection, scroll, column widths) stays in Toolbelt; the plugin only
// hears about meaningful events.
//
// Times are epoch milliseconds (`at`); Toolbelt shows them relative to now ("in 2h 14m",
// "5m ago") and keeps them current, so a countdown doesn't need a render every second.
//
// Each plugin gets a folder of its own for data: the `TOOLBELT_DATA_DIR` environment variable
// (`~/Library/Application Support/Toolbelt/data/<id>/`).

export const PROTOCOL_VERSION = 0;

/** `toolbelt.json`, next to the plugin's entry file. */
export type Manifest = {
	id: string;
	name: string;
	/** A lucide icon name, kebab-case ("activity", "list-checks"). */
	icon: string;
	version: string;
	description?: string;
	/** Which protocol the plugin speaks. */
	protocol: number;
	/** The program, relative to the manifest; run with Bun. */
	entry: string;
	/** Tabs in the window. The first one with `default: true` (or the first) opens first. */
	screens: { id: string; title: string; icon?: string; default?: boolean }[];
	/** The plugin offers a compact view in the menu bar popover. */
	quickView?: boolean;
	repo?: string;
	updateFeed?: string;
	/** The plugin's command line, reachable as `tb <command>`. */
	cli?: { command: string };
};

export type Tone = "default" | "muted" | "success" | "warning" | "danger" | "info";

/** A table cell: plain text, or text with decoration. */
export type Cell =
	| string
	| number
	| null
	| {
			text: string;
			/** Second line, smaller and muted. */
			sub?: string;
			mono?: boolean;
			tone?: Tone;
			/** A small status dot before the text. */
			dot?: Tone;
			/** Small outlined chips after the text (ports, tags). */
			chips?: string[];
			/** Render the text as a badge. */
			badge?: boolean;
			/** A moment (epoch ms), shown relative to now and kept current; replaces `text`. */
			at?: number;
	  };

export type Column = {
	key: string;
	title: string;
	align?: "left" | "right";
	/** This column takes the remaining width. */
	grow?: boolean;
	mono?: boolean;
	/** Hidden in narrow layouts. */
	optional?: boolean;
};

export type Action = {
	id: string;
	label: string;
	/** A lucide icon name. */
	icon?: string;
	tone?: "default" | "destructive";
	/** Ask before running: the question to ask. */
	confirm?: string;
	/** Show as a button in the row (otherwise only in the row's menu). */
	inline?: boolean;
	/** The main action of a toolbar, card or dialog: drawn as a filled button. */
	primary?: boolean;
	disabled?: boolean;
};

export type Row = {
	id: string;
	cells: Record<string, Cell>;
	/** Rows with the same group are shown together under a header. */
	group?: string;
	/** Row actions; ids of entries in the table's `actions`. Defaults to all. */
	actions?: string[];
	/** Shown in the inspector when the row is selected. */
	details?: { label: string; value: string; mono?: boolean }[];
	/** Rows nested under this one (a process's children); the person expands them. */
	children?: Row[];
};

export type Field =
	| { type: "select"; id: string; label: string; value: string; options: { value: string; label: string }[]; description?: string }
	| { type: "switch"; id: string; label: string; value: boolean; description?: string }
	| { type: "text"; id: string; label: string; value: string; placeholder?: string; description?: string };

/** A line of output in a `log`. */
export type LogLine = { text: string; at?: number; tone?: Tone };

/**
 * A modal the plugin opens by putting it on its page, and closes by taking it off. Its actions
 * arrive as events with `{ dialog: id }`; Esc, the close button and Cancel send `dialog-close`.
 */
export type Dialog = {
	id: string;
	title: string;
	description?: string;
	children: Node[];
	actions?: Action[];
	/** Room for release notes, logs, tables. */
	wide?: boolean;
};

export type Node =
	| { type: "stack"; direction?: "row" | "column"; gap?: number; children: Node[] }
	| {
			type: "page";
			/** Optional search box; changes arrive as `event` named `search`. */
			search?: { placeholder: string };
			/** Buttons in the page toolbar. */
			actions?: Action[];
			/** Muted text in the toolbar ("12 processes"). */
			summary?: string;
			children: Node[];
			/** A modal over the page, while present. */
			dialog?: Dialog;
	  }
	| {
			type: "table";
			id: string;
			columns: Column[];
			rows: Row[];
			actions?: Action[];
			/**
			 * Rows get checkboxes, and these actions apply to the checked ones: the event's payload
			 * is `{ rowIds }`. Which rows are checked is Toolbelt's business until then.
			 */
			bulkActions?: Action[];
			/** Shown when there are no rows. */
			empty?: { title: string; description?: string; icon?: string };
	  }
	| {
			type: "list";
			id: string;
			/** `metaAt` shows a moment (epoch ms) relative to now instead of `meta`. */
			items: { id: string; title: string; subtitle?: string; dot?: Tone; meta?: string; metaAt?: number; actions?: Action[] }[];
			empty?: { title: string; description?: string; icon?: string };
	  }
	/** `at` shows a moment (epoch ms) relative to now instead of `value`. */
	| { type: "stats"; items: { label: string; value: string; at?: number; hint?: string; tone?: Tone }[] }
	| { type: "form"; id: string; title?: string; description?: string; fields: Field[] }
	| { type: "empty"; title: string; description?: string; icon?: string }
	| { type: "text"; text: string; tone?: Tone; mono?: boolean }
	/** A titled box. Its actions arrive with `{ rowId: id }`. */
	| { type: "card"; id?: string; title?: string; description?: string; tone?: Tone; actions?: Action[]; children: Node[] }
	/** Label / value pairs. */
	| { type: "details"; items: { label: string; value: string; mono?: boolean; tone?: Tone }[] }
	/** Output of a command: monospace, scrolls; `follow` keeps the newest line in view. */
	| { type: "log"; id: string; lines: LogLine[]; follow?: boolean; empty?: string }
	/** `value` from 0 to 1; without one, "working…". `at`: when it started (shows elapsed time). */
	| { type: "progress"; label?: string; value?: number; at?: number; tone?: Tone }
	/**
	 * Markdown (release notes, descriptions): headings, paragraphs, lists, quotes, code, emphasis,
	 * links (opened in the browser). Raw HTML is shown as text, never interpreted.
	 */
	| { type: "markdown"; text: string };

export type HostMessage =
	| { type: "hello"; protocol: number; plugin: { id: string }; host: { name: string; version: string } }
	| { type: "open"; surface: string }
	| { type: "close"; surface: string }
	| { type: "event"; surface: string; name: string; payload?: unknown };

export type PluginMessage =
	| { type: "render"; surface: string; tree: Node }
	| { type: "badge"; value: number | string | null }
	| { type: "toast"; text: string; tone?: "default" | "success" | "error" };

/** Events Toolbelt sends, by `name`. */
export type EventPayloads = {
	/** A table/list/card/dialog action: `name` is the action id. */
	action: { rowId?: string; rowIds?: string[]; dialog?: string };
	/** The person closed a dialog (Esc, close button, Cancel). */
	"dialog-close": { dialog: string };
	search: { query: string };
	/** A form field changed. */
	field: { form: string; field: string; value: string | boolean };
};

/** Parse a manifest and check the parts Toolbelt relies on. Throws with a readable message. */
export function parseManifest(json: unknown): Manifest {
	const m = json as Partial<Manifest>;
	const need = (ok: unknown, what: string) => {
		if (!ok) throw new Error(`toolbelt.json: ${what}`);
	};
	need(m && typeof m === "object", "not an object");
	need(typeof m.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(m.id), "`id` must be lowercase letters, digits and dashes");
	need(typeof m.name === "string" && m.name.trim(), "`name` is required");
	need(typeof m.entry === "string" && m.entry, "`entry` is required");
	need(m.protocol === PROTOCOL_VERSION, `\`protocol\` must be ${PROTOCOL_VERSION} (got ${m.protocol})`);
	need(Array.isArray(m.screens) && m.screens.length > 0, "at least one screen is required");
	for (const s of m.screens!) need(typeof s.id === "string" && typeof s.title === "string", "each screen needs `id` and `title`");
	return {
		...m,
		icon: typeof m.icon === "string" ? m.icon : "box",
		version: typeof m.version === "string" ? m.version : "0.0.0",
	} as Manifest;
}

/** The screen that opens first. */
export const defaultScreen = (m: Manifest) => (m.screens.find((s) => s.default) ?? m.screens[0]).id;

/** Split a JSON-lines stream into messages; keeps the unfinished tail. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts.map((l) => l.trim()).filter(Boolean), rest };
}
