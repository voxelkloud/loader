/**
 * Discriminant for every error this package throws.
 *
 * Task 3 added `"hierarchy-error"` and `"range-request-unsupported"`; Task 4
 * added `"unsupported-encoding"`, `"unsupported-attribute"`,
 * `"brotli-unavailable"` and `"decode-error"`. Each EXTENDS this union rather
 * than introducing a second error type; a code exists when the CALLER'S
 * REACTION differs, not merely because the failure does.
 */
export type VoxelkloudErrorCode =
  /** The input did not resolve to an absolute http:/https:/file: URL. */
  | "invalid-url"
  /** `fetch` rejected: DNS, CORS, connection reset. `status` is undefined. */
  | "network-error"
  /** The response was not 2xx. `status` is set. */
  | "http-error"
  /** The body was not valid JSON. */
  | "invalid-json"
  /**
   * Recognised, but not a Potree v2 manifest: a v1 cloud.js, an Entwine
   * ept.json, a 3D Tiles tileset.json, a LAS/COPC file, an HTML page, or a
   * manifest whose `version` major is not 2.
   */
  | "unsupported-format"
  /**
   * A structural problem in an otherwise-v2 manifest. `path` names the
   * offending field and the message carries expected vs received.
   */
  | "invalid-metadata"
  /**
   * hierarchy.bin is corrupt or self-inconsistent: a misaligned or
   * out-of-bounds chunk, a cycle, a record count that does not reconstruct a
   * breadth-first tree, or an i64 that is negative or beyond 2^53. `path`
   * carries `<nodeName>#<recordIndex>`.
   */
  | "hierarchy-error"
  /**
   * The server does not honour `Range`, so a chunk cannot be fetched. Distinct
   * from `"hierarchy-error"` because the caller reaction is different: the file
   * is fine, the host is misconfigured.
   */
  | "range-request-unsupported"
  /**
   * The manifest's `encoding` is not one this loader can decode. Task 2 only
   * WARNS about an unknown encoding, because a manifest must stay readable;
   * this is where it becomes fatal, at the point bytes must actually be
   * interpreted.
   */
  | "unsupported-encoding"
  /**
   * The requested attribute selection cannot be served: an unknown name, an
   * explicitly named int64/uint64, or `numElements > 4`. Thrown at layout time
   * with zero I/O — the caller's fix is to change the selection, which is a
   * different action from every other code here.
   */
  | "unsupported-attribute"
  /**
   * The cloud is BROTLI-encoded and no decompressor is reachable. The data is
   * fine; the fix is caller configuration, and the message carries the literal
   * one-line remedy.
   */
  | "brotli-unavailable"
  /** The bytes did not decode: a length mismatch, or an unrepresentable value. */
  | "decode-error"
  /**
   * This environment cannot create a WebGPU device. Nothing about the data is
   * wrong — the app renders a fallback, or accepts three's WebGL2 backend.
   */
  | "webgpu-unavailable"
  /**
   * The view cannot bind the decoded payload it was given: a colour mode whose
   * attribute the cloud does not carry, or a position format the material has
   * no path for. Distinct from `"unsupported-attribute"`, which is the LOADER
   * saying a selection cannot be served — sharing one code would leave a caller
   * unable to tell which layer failed and which knob to turn.
   */
  | "unsupported-point-data"
  /** Shader compilation failed. The device and the data are both fine. */
  | "shader-error";

export interface VoxelkloudErrorOptions {
  /** The absolute URL under inspection, when one had been resolved. */
  readonly url?: string;
  /**
   * Where the problem is: a JSON path into the manifest (`attributes[3].min`),
   * or `<nodeName>#<recordIndex>` for a hierarchy.bin record (`r047#12`).
   */
  readonly path?: string;
  /** HTTP status, for `"http-error"`. */
  readonly status?: number;
  readonly cause?: unknown;
}

// A `Symbol.for` brand rather than `instanceof`: a pnpm workspace plus a
// bundler can put two copies of this package in one tree, across which
// `instanceof` silently returns false.
const BRAND = Symbol.for("voxelkloud.error");

/**
 * The single error type @voxelkloud/loader throws. Switch on `code`; `path`,
 * `url` and `status` carry the detail, which is what keeps the code union small
 * and the class count at one.
 *
 * Fail-fast: the first fatal problem throws. There is no aggregated issue list
 * — converter output is either valid or the wrong format entirely, and a single
 * error naming the path, the expectation and the received value is fully
 * actionable.
 *
 * A caller-supplied signal's `AbortError`/`TimeoutError` is re-thrown UNTOUCHED,
 * never wrapped, so `err.name === "AbortError"` works as usual.
 *
 * Prefer {@link isVoxelkloudError} over `instanceof`.
 */
export class VoxelkloudError extends Error {
  override readonly name = "VoxelkloudError";
  readonly code: VoxelkloudErrorCode;
  readonly url: string | undefined;
  readonly path: string | undefined;
  readonly status: number | undefined;

  constructor(
    code: VoxelkloudErrorCode,
    message: string,
    options: VoxelkloudErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.code = code;
    this.url = options.url;
    this.path = options.path;
    this.status = options.status;
    Object.defineProperty(this, BRAND, { value: true, enumerable: false });
  }
}

/** Cross-realm / cross-copy safe check, via a `Symbol.for` brand. */
export function isVoxelkloudError(value: unknown): value is VoxelkloudError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === true
  );
}

/** Internal throw helper — keeps call sites to one expression. */
export function fail(
  code: VoxelkloudErrorCode,
  message: string,
  options?: VoxelkloudErrorOptions,
): never {
  throw new VoxelkloudError(code, message, options);
}
