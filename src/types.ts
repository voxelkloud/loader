import type {
  BoundingBox,
  PointAttributeTypeName,
  PointCloudMetadata,
} from "@voxelkloud/core";

/**
 * The `fetch` shape this package needs.
 *
 * `input` is narrowed to `string` deliberately: the global `fetch` (whose
 * parameter is the wider `RequestInfo | URL`) stays assignable by
 * contravariance, and so does a user hook typed `(input: string, ...)`. We
 * always call it with a string.
 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * How this source reaches its remaining files.
 *
 * Carried on {@link PointCloudSource} so Tasks 3 and 4 inherit the caller's
 * auth, signing, caching and retry policy instead of falling back to a bare
 * global `fetch` — the still-open bug tentone/potree-core#54, where
 * metadata.json loads with an auth header and every node request then 401s.
 *
 * Deliberately carries NO `AbortSignal`: a signal scoped to the manifest load
 * must not silently abort later hierarchy/point requests. Every subsequent call
 * takes its own. Headers live inside `requestInit`; there is exactly one static
 * hook and one dynamic hook, not three.
 */
export interface PointCloudTransport {
  readonly fetch: FetchLike;
  /**
   * Merged into every request Tasks 3 and 4 make. They must merge headers via
   * `const h = new Headers(requestInit?.headers); h.set("Range", ...)` so the
   * `Headers`, array and record forms all work, and must always override
   * `signal` with their own per-request signal.
   */
  readonly requestInit: RequestInit | undefined;
}

export interface PointCloudTransportOptions {
  /** Defaults to the global `fetch` (Node >= 20, all modern browsers). */
  readonly fetch?: FetchLike;
  /**
   * Baseline init for every request, now and in Tasks 3/4. Put
   * `headers: { Authorization: ... }` here.
   */
  readonly requestInit?: RequestInit;
}

/**
 * Fully resolved absolute URLs, computed once at load. Tasks 3 and 4 read these
 * and never re-derive anything. Plain strings, so they are JSON-serialisable,
 * structured-cloneable, and already the type `fetch` wants.
 */
export interface PointCloudUrls {
  /** Directory URL. Always ends with `/`. Query and fragment stripped. */
  readonly base: string;
  readonly metadata: string;
  readonly hierarchy: string;
  readonly octree: string;
}

/**
 * The only two attributes with a non-generic decode path in the reference
 * decoder. Deliberately a closed 2-member union, not an open taxonomy:
 * everything else (intensity, classification, gps-time, ...) goes down the
 * generic branch and is found by name via `attributesByName`.
 *
 * Assigned by exact-name membership, which collapses three aliases the
 * reference scatters across two files:
 *   position: "position" | "POSITION_CARTESIAN"
 *   color:    "rgb" | "rgba" | "RGBA"
 */
export type AttributeRole = "position" | "color";

/** One manifest attribute plus the record-layout arithmetic derived from it. */
export interface PointAttribute {
  /**
   * VERBATIM from the manifest. Never renamed, slugified or camelCased — this
   * is the on-disk identity. Real names contain spaces and a hyphen: "return
   * number", "number of returns", "scan angle rank", "user data", "point source
   * id", "gps-time". In particular `"rgb"` stays `"rgb"`.
   */
  readonly name: string;
  /**
   * Derived semantic tag; `undefined` for everything else. Task 4 dispatches on
   * this, never on name strings.
   */
  readonly role: AttributeRole | undefined;
  /** `""` when the manifest omits it (which is also what the converter emits). */
  readonly description: string;
  readonly type: PointAttributeTypeName;
  readonly numElements: number;
  /**
   * `POINT_ATTRIBUTE_TYPE_SIZE[type]` — the canonical width, NOT the manifest's
   * declared `elementSize` (which is cross-checked, warned on, then discarded).
   */
  readonly elementSize: number;
  /** `numElements * elementSize`. This attribute's stride contribution. */
  readonly byteSize: number;
  /**
   * Byte offset of this attribute within one point record.
   *
   * @remarks Meaningful only when `encoding` is `"DEFAULT"` or
   * `"UNCOMPRESSED"`. A BROTLI stream decompresses to per-attribute contiguous
   * blocks with attribute-specific widths and this value does not apply.
   */
  readonly byteOffset: number;
  /**
   * SEMANTIC bounds in the attribute's own domain, length exactly
   * `numElements`. Copied verbatim and NEVER validated against `type`:
   *   - "scan angle rank" is `uint8` with `min: [-21]` (LAS stores a signed
   *     rank in a raw byte) — a stock PotreeConverter output.
   *   - "position" is `int32` with non-integer doubles, because position
   *     min/max are in absolute CRS units (post scale+offset).
   * `min[i] > max[i]` and `min[i] === max[i]` are both tolerated.
   */
  readonly min: readonly number[];
  readonly max: readonly number[];
  /**
   * Per-element affine transform, length `numElements`. All-1s / all-0s when
   * the manifest omits them (the synthetic fixture omits both). Read by NOBODY
   * in the entire reference codebase, which is why a non-identity value earns a
   * warning.
   *
   * NOT the position quantization — that is the TOP-LEVEL
   * `metadata.scale`/`metadata.offset`. `position` carries `scale: [1,1,1]`
   * here while the real quantization is `[0.01,0.01,0.01]`.
   */
  readonly scale: readonly number[];
  readonly offset: readonly number[];
  /**
   * Value histogram, 256 buckets in practice. Emitted by PotreeConverter for
   * ANY attribute with `size === 1` whose buckets are not all zero — it is not
   * classification-specific, it just happens to appear only there in the real
   * fixture, where it sums to exactly `metadata.points`. Length is NOT
   * validated.
   */
  readonly histogram: readonly number[] | undefined;
  /**
   * Constants for packing this attribute's values into a float32 buffer:
   * `f32 = (value - offset) * scale`, exactly as the reference decoder does.
   *
   * Present ONLY when `numElements === 1 && elementSize > 4` (double, int64,
   * uint64) — the case where the reference computes `scale = 1/(max-min)` and a
   * degenerate range yields `Infinity`, turning every decoded value into NaN.
   * The `(max - min) || 1` guard is baked in here, and a degenerate range also
   * emits a `degenerate-range` warning.
   *
   * This is the generalised form of potree's `if (name === "gps-time")` hack
   * (potree/potree#909): the root cause is the WIDTH, not the name, so a
   * converter emitting `"gpsTime"` is covered too.
   *
   * `undefined` means no packing is needed — use the raw value.
   */
  readonly normalization:
    | { readonly offset: number; readonly scale: number }
    | undefined;
}

export type PointCloudWarningCode =
  /** `version` absent, unparseable, or `"2.y"` with `y !== 0`. */
  | "unexpected-version"
  /** `encoding` outside {DEFAULT, BROTLI, UNCOMPRESSED}; kept verbatim. */
  | "unknown-encoding"
  /** `points` absent; defaulted to 0. */
  | "missing-point-count"
  /**
   * `size !== numElements * typeSize` or `elementSize !== typeSize`. The
   * canonical table wins; the message carries both numbers.
   */
  | "declared-size-mismatch"
  /**
   * `min[0] === max[0]` on a scalar with `elementSize > 4`; `normalization` was
   * synthesised with a denominator of 1.
   */
  | "degenerate-range"
  /** `min[i] > max[i]`; values copied verbatim regardless. */
  | "inverted-range"
  /**
   * Per-attribute `scale` not all-1 or `offset` not all-0 — exactly where the
   * reference decoder is silently wrong, since it reads neither.
   */
  | "non-identity-attribute-transform"
  /** `int64`/`uint64`; parses fine, Task 4 will throw. */
  | "undecodable-attribute-type"
  /** Two attributes share a name; `attributesByName` keeps the FIRST. */
  | "duplicate-attribute-name"
  /**
   * No attribute with `role === "position"`; `tightBoundingBox` falls back to
   * the cubic box.
   */
  | "missing-position-attribute"
  /**
   * Axis extents differ by more than a 1e-6 relative epsilon. Octree
   * subdivision halves each axis independently and is only valid on a cube.
   */
  | "non-cubic-bounding-box"
  /** The position attribute's min/max escapes `boundingBox`. */
  | "tight-bounds-outside-bounding-box"
  /**
   * `hierarchy.firstChunkSize` is not a multiple of 22 (the node record size).
   * Warned, not thrown — Task 3 fails loudly on a bad value.
   */
  | "suspicious-first-chunk-size"
  /**
   * A hierarchy record has `byteSize === 0` but claims `numPoints > 0`;
   * `numPoints` was forced to 0 (potree/potree#1125 — "some inner nodes
   * erroneously report >0 points"; `byteSize` is the trustworthy field). Task 4
   * must additionally issue NO request for such a node.
   */
  | "zero-byte-node"
  /**
   * `numPoints * bytesPerPoint !== byteSize` on a non-BROTLI source: the
   * hierarchy and the manifest's attribute list disagree about the record
   * stride, which is a Task 4 decode-garbage bug caught for free at parse time.
   * Gated on `!isBrotli` — a BROTLI `byteSize` is a COMPRESSED length, and 0 of
   * 117 brotli records satisfy the identity against 4378/4378 uncompressed.
   */
  | "stride-mismatch"
  /**
   * After full expansion, the sum of `numPoints` does not equal
   * `metadata.points`. Not fatal: every node's byte range is still
   * self-describing, so this poisons the LOD budget rather than the bytes.
   */
  | "point-count-mismatch"
  /**
   * The server answered 200 to a Range request. The body was the whole file and
   * has been adopted as the resident buffer, so every remaining chunk is served
   * from memory. Turns potree/potree#1078 — a swallowed TypeError plus an
   * unbounded per-frame retry storm — into a working viewer and one actionable
   * line naming the host.
   */
  | "range-requests-ignored"
  /**
   * The whole-file hierarchy prefetch was skipped or failed (over
   * `maxPrefetchBytes`, or the request errored), so the loader fell back to
   * per-chunk Range requests. This is why you might see 192 requests, not 1.
   */
  | "hierarchy-prefetch-skipped"
  /**
   * `cubicSide / min(scale) > 2 ** 23`, so float32 positions cannot hold one
   * quantization step even relative to the cloud origin. The message names the
   * computed worst-case error in metres and points at `positionFormat: "int32"`
   * and `origin: "node"`. autzen measures 2^18.83 — a factor of 18 of headroom.
   */
  | "position-precision-degraded"
  /**
   * A uint16 colour attribute declares `max <= 255`, which is genuinely
   * undecidable between 8-bit-stored-in-16 and a very dark 16-bit source.
   * Passthrough (no shift) is chosen.
   */
  | "ambiguous-color-range"
  /** The colour attribute's type is neither uint8 nor uint16. */
  | "unexpected-color-type"
  /**
   * The position attribute's type is not int32. It is read through its declared
   * type rather than the reference's hardcoded getInt32.
   */
  | "unexpected-position-type"
  /**
   * A selected BROTLI attribute has `numElements > 1` and is neither position
   * nor colour. Both of those are special-cased in the converter's writer, so a
   * third special case cannot be ruled out from the fixtures; the naive
   * `numElements * elementSize` width is assumed and the length identity
   * adjudicates.
   */
  | "unverified-brotli-attribute";

/**
 * A tolerated anomaly. Data on the source, never a console write and never a
 * callback: one channel, assertable in tests with no spies.
 */
export interface PointCloudWarning {
  readonly code: PointCloudWarningCode;
  /**
   * Where the anomaly is: a JSON path into the manifest
   * (`attributes[5].size`), or a node name / URL for a hierarchy warning.
   */
  readonly path: string;
  readonly message: string;
}

/**
 * Everything Tasks 3-7 need about a point cloud, minus its actual points.
 *
 * Deeply frozen (the `ReadonlyMap` excepted — a Map's contents cannot be
 * frozen; it is readonly by type only). Nothing here triggers I/O and nothing
 * is mutated after construction.
 *
 * Every field except `transport` is structured-cloneable. The Task-4 decode
 * worker never needs `transport`: the main thread issues the Range request and
 * posts the ArrayBuffer plus `attributes`, `bytesPerPoint` and
 * `metadata.scale`/`offset`.
 */
export interface PointCloudSource {
  /**
   * The validated, defaulted manifest. Reach through this for `points`,
   * `spacing`, `scale`, `offset`, `boundingBox`, `hierarchy.firstChunkSize`,
   * `encoding`, `projection`, `name`. Not duplicated onto this object.
   */
  readonly metadata: PointCloudMetadata;
  readonly urls: PointCloudUrls;
  /** In manifest order — this IS the record field order. */
  readonly attributes: readonly PointAttribute[];
  /**
   * O(1) lookup, built once. On a duplicate name (warned, never thrown) the
   * FIRST occurrence wins; `attributes` keeps both with correct offsets.
   */
  readonly attributesByName: ReadonlyMap<string, PointAttribute>;
  /**
   * Sum of every attribute's `byteSize`: the per-point record stride.
   *
   * @remarks DEFAULT/UNCOMPRESSED only. Never derive a point count from a byte
   * length when `isBrotli`.
   */
  readonly bytesPerPoint: number;
  /**
   * The ONLY encoding predicate any caller should branch on. Every reference
   * client compares `=== "BROTLI"` and any other comparison is a bug.
   */
  readonly isBrotli: boolean;
  /**
   * The genuinely tight data extent in absolute CRS units, from the
   * position-role attribute's `min`/`max`. Falls back to `metadata.boundingBox`
   * (with a `missing-position-attribute` warning) when there is no usable
   * position attribute, so callers never branch.
   *
   * This is what camera fit-to-view and elevation ramps want. Potree's field of
   * the same name is a clone of the CUBIC box, i.e. not tight at all: on autzen
   * it reports a Z extent of 4655.51 against a true extent of 209.12.
   */
  readonly tightBoundingBox: BoundingBox;
  /** Tolerated anomalies, in document order. Empty for both fixtures. */
  readonly warnings: readonly PointCloudWarning[];
  /** Reuse this for hierarchy.bin and octree.bin requests. */
  readonly transport: PointCloudTransport;
}
