// Every provider Upkeep knows, in the order Discover lists them.
import type { Provider } from "../lib/types";
import { brewProvider } from "./brew";
import { customProvider } from "./custom";
import { gitProvider } from "./git";
import { cargoProvider, npmProvider, pipxProvider, uvToolProvider } from "./packages";
import { bunProvider, claudeProvider, denoProvider, goProvider, nodeProvider, rustProvider, uvProvider } from "./runtimes";
import { sparkleProvider } from "./sparkle";

export const PROVIDERS: Provider[] = [brewProvider, sparkleProvider, nodeProvider, bunProvider, denoProvider, uvProvider, rustProvider, goProvider, claudeProvider, npmProvider, uvToolProvider, pipxProvider, cargoProvider, gitProvider, customProvider];

export const provider = (id: string) => PROVIDERS.find((p) => p.id === id);
