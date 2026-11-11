// Settings the providers read (set by the engine), and small helpers they share.
import type { Settings } from "../lib/store";
import { DEFAULT_SETTINGS } from "../lib/store";

let current: Settings = DEFAULT_SETTINGS;
export const setProviderSettings = (s: Settings) => void (current = s);
export const settings = () => current;
export const useGh = () => current.useGh;

/** Read a key from an app's Info.plist (plutil; no shell). */
export async function plistValue(run: (argv: string[]) => Promise<{ code: number; out: string }>, plist: string, key: string): Promise<string | undefined> {
	const r = await run(["/usr/bin/plutil", "-extract", key, "raw", "-o", "-", plist]);
	return r.code === 0 ? r.out.trim() : undefined;
}
