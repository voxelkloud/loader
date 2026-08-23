import { potreeFormat } from "@voxelkloud/format-potree";
import { formats } from "./registry.js";

let installed = false;

/**
 * Register the drivers this package ships with, once.
 *
 * DELIBERATELY NOT a module-scope `formats.register(...)` in `index.ts`. This
 * package declares `"sideEffects": false`, which is true and worth keeping —
 * but it also licenses a bundler to drop a module whose only contribution is a
 * side effect. A registration performed at import time is exactly that, so the
 * Potree driver would vanish from a production bundle and every load would fail
 * with `"unsupported-format"` against a URL that works in dev.
 *
 * Called from the load path instead, where it cannot be shaken away because the
 * function that performs it is the one doing the work.
 */
export function ensureDefaultFormats(): void {
  if (installed) return;
  installed = true;
  formats.register(potreeFormat);
}
