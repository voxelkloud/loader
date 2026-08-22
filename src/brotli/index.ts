// The `@voxelkloud/loader/brotli` entry point.
//
// Deliberately a SEPARATE subpath, never imported by the main entry point,
// statically or dynamically. A BROTLI-encoded cloud on an engine without native
// brotli fails with a `"brotli-unavailable"` error whose message names the two
// lines below, rather than silently pulling 66 KB gzipped of third-party code
// into every bundle that happens to touch a compressed cloud — which would meet
// the zero-dependency constraint in the letter and break it in spirit, and would
// fail under a strict CSP.
//
// ```ts
// const { brotliDecompress } = await import("@voxelkloud/loader/brotli");
// await loadPointData(source, node, { decompress: brotliDecompress });
// ```

import { BrotliDecode } from "./decode.js";
import type { BrotliDecompress } from "../point-data-types.js";

/**
 * A pure-JS brotli decompressor, for engines with no native one.
 *
 * `BrotliDecode` takes an `Int8Array` view — the same bytes, reinterpreted, not
 * a copy.
 */
export const brotliDecompress: BrotliDecompress = (input) =>
  BrotliDecode(new Int8Array(input.buffer, input.byteOffset, input.byteLength));
