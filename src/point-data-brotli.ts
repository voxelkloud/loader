import { nativeBrotli } from "#brotli-native";
import { VoxelkloudError } from "./errors.js";
import type {
  BrotliDecompress,
  PointRecordLayout,
} from "./point-data-types.js";

/**
 * A brotli decompressor resolved from the environment, or `undefined`.
 *
 * Memoised per realm because tier 3 costs a `DecompressionStream` construction
 * to probe and tier 2 an import; neither changes over a page's life.
 */
let resolved: BrotliDecompress | null | undefined;

async function streamDecompress(input: Uint8Array): Promise<Uint8Array> {
  const Ctor = (
    globalThis as unknown as {
      DecompressionStream: new (format: string) => TransformStream<
        Uint8Array,
        Uint8Array
      >;
    }
  ).DecompressionStream;
  const stream = new Ctor("brotli");
  const writer = stream.writable.getWriter();
  void writer.write(input);
  void writer.close();

  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function resolveDecompressor(): BrotliDecompress | undefined {
  if (resolved !== undefined) return resolved ?? undefined;

  // Tier 2: Node's zlib, reached through the #brotli-native imports condition
  // rather than a static import, so a browser bundle never sees node:zlib.
  const native = nativeBrotli;
  if (native !== undefined) {
    resolved = (input) => native(input);
    return resolved;
  }

  // Tier 3: DecompressionStream("brotli"). Feature-detected BY CONSTRUCTION —
  // version checks are unusable because "brotli" throws a TypeError on every
  // engine that lacks it, and "br" (the Content-Encoding token) throws even
  // where "brotli" works.
  const Ctor = (globalThis as { DecompressionStream?: unknown })
    .DecompressionStream;
  if (typeof Ctor === "function") {
    try {
      // eslint-disable-next-line no-new
      new (Ctor as new (format: string) => unknown)("brotli");
      resolved = streamDecompress;
      return resolved;
    } catch {
      // Not supported on this engine; fall through.
    }
  }

  resolved = null;
  return undefined;
}

/** Test seam: forget the memoised tier so a test can exercise each branch. */
export function resetBrotliCascade(): void {
  resolved = undefined;
}

/**
 * Decompress one node's blob, or pass it through unchanged.
 *
 * Identity (and zero-copy) for DEFAULT/UNCOMPRESSED. For BROTLI this is the only
 * async stage in the pipeline, and the measured cost centre — 209 ns/pt native
 * and 472 ns/pt in JS, against 43 ns/pt for the morton decode.
 *
 * The decompressor is resolved in three tiers: a caller-supplied `decompress`,
 * then Node's `zlib.brotliDecompressSync`, then `DecompressionStream("brotli")`.
 * A fourth tier — the vendored JS decoder at `@voxelkloud/loader/brotli` — is
 * NEVER auto-imported: pulling 66 KB gzipped of third-party code in on the first
 * BROTLI node would satisfy the zero-dependency constraint in the letter while
 * violating it in spirit, and it breaks under a strict CSP.
 *
 * @throws {VoxelkloudError} `"brotli-unavailable"`, `"decode-error"`.
 */
export async function decompressNodeBytes(
  layout: PointRecordLayout,
  bytes: ArrayBuffer,
  numPoints: number,
  options: { readonly decompress?: BrotliDecompress } = {},
): Promise<ArrayBuffer> {
  if (!layout.isBrotli) return bytes;
  if (numPoints === 0 || bytes.byteLength === 0) return new ArrayBuffer(0);

  const decompress = options.decompress ?? resolveDecompressor();
  if (decompress === undefined) {
    throw new VoxelkloudError(
      "brotli-unavailable",
      `This point cloud is BROTLI-encoded and no brotli decompressor is ` +
        `available in this environment. Pass one:\n\n` +
        `  const { brotliDecompress } = await import("@voxelkloud/loader/brotli");\n` +
        `  await loadPointData(source, node, { decompress: brotliDecompress });\n`,
      { url: layout.sourceId },
    );
  }

  const expected = numPoints * layout.stride;
  let out: Uint8Array;
  try {
    out = await decompress(new Uint8Array(bytes), expected);
  } catch (cause) {
    throw new VoxelkloudError(
      "decode-error",
      `Brotli decompression failed for a ${bytes.byteLength}-byte node blob.`,
      { url: layout.sourceId, cause },
    );
  }

  // Return a standalone buffer: the decompressor may hand back a view into a
  // larger pooled buffer, and the decoder addresses from byteOffset 0.
  return out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
    ? (out.buffer as ArrayBuffer)
    : (out.buffer.slice(
        out.byteOffset,
        out.byteOffset + out.byteLength,
      ) as ArrayBuffer);
}
