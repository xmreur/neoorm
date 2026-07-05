import type { Manifest } from "../dialect/types.js";
import { registerPlugin } from "./registry.js";
import { builtinPlugin } from "./builtin.js";
import { postgisPlugin } from "./postgis/plugin.js";

function activateExtension(name: string): void {
  switch (name) {
    case "postgis":
      registerPlugin(postgisPlugin);
      break;
    default:
      break;
  }
}

export function ensurePlugins(manifest: Manifest): void {
  registerPlugin(builtinPlugin);

  for (const ext of manifest.extensions ?? []) {
    activateExtension(ext);
  }
}
