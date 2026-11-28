// Upkeep: keeps what you choose up to date. See docs/architecture.md.
//
// Nothing is checked or changed until you choose: a fresh install watches nothing, scanning
// only reads, and updates are "notify only" until you turn automatic updates on (globally and
// per item). Everything is recorded in the audit log (Activity).
import { dataDir, definePlugin } from "@toolbelt/sdk";
import { createUpkeep } from "./plugin";

definePlugin(createUpkeep(dataDir()).definition);
