import type {
  BoundingBox,
  PointAttributeTypeName,
  Vec3,
} from "@voxelkloud/core";
import type {
  AttributeRole,
  PointAttribute,
  PointCloudWarning,
} from "./types.js";

// Everything here except LoadPointDataOptions.signal/.decompress is
// structured-cloneable. That is the invariant that keeps a future worker a
// drop-in rather than a redesign.

/**
 * Everything Task 4 needs about a node, and nothing more.
 *
 * A Task 3 `HierarchyNode` satisfies this STRUCTURALLY, so no extraction step is
 * needed — but a `HierarchyNode` is cyclic via `parent` and cannot cross a
 * worker boundary (structured clone would deep-copy all 4377 autzen nodes per
 * message), so the decode path is typed against this flat subset.
 *
 * `minX..maxZ` are in ABSOLUTE CRS UNITS, Task 3's frame.
 */
export interface PointNodeRef {
  /** Task 3's dense, stable index. The only correlation key back to the tree. */
  readonly index: number;
  /** `"r0402"`. Diagnostics, error `path`, cache keys. */
  readonly name: string;
  /** Authoritative. Never inferred from a byte length. */
  readonly numPoints: number;
  /** `undefined` while the node is `"unexpanded"`. */
  readonly byteOffset: number | undefined;
  readonly byteSize: number | undefined;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/**
 * - `"float32"` (default) — `Float32Array`, `3 * numPoints`, CRS units relative
 *   to {@link PointPositionFrame.origin}. `frame.scale` is `[1,1,1]`.
 * - `"int32"` — `Int32Array`, the stored quantized integers verbatim. Exactly
 *   lossless. `frame.scale` is `metadata.scale`.
 */
export type PositionFormat = "float32" | "int32";

/**
 * Which point {@link PointPositionFrame.origin} is.
 *
 * - `"cloud"` (default) — `metadata.boundingBox.min`. The SAME triple for every
 *   node, so one model matrix serves the whole cloud and node buffers stay
 *   concatenable into a shared vertex buffer.
 * - `"node"` — this node's box min. Buys one mantissa bit per level (measured
 *   identical to `"cloud"` at the root; 3.7e-6 m against 1.2e-4 m at level 6,
 *   both already far finer than the 0.01 m the file stores) and costs a
 *   distinct model matrix per node.
 * - `"file"` — `metadata.offset`. Forced, and the only legal value, when
 *   `format === "int32"`: the stored integers are quantized about
 *   `metadata.offset` and re-basing them would need a non-integer shift.
 */
export type OriginPolicy = "cloud" | "node" | "file";

/**
 * The frame {@link DecodedPointData.positions} lives in, carried as DATA on
 * every result so no consumer has to know a convention.
 *
 * One reconstruction formula covers both formats:
 *
 * ```
 * absolute[k] = origin[k] + positions[3 * i + k] * scale[k]
 * ```
 *
 * float32 cannot hold absolute CRS coordinates. autzen's X (635,577..640,233)
 * and Y (848,882..853,537) both live in the binade [2^19, 2^20) where the
 * float32 ULP is 0.0625 m — a measured max error of 0.030 m, THREE TIMES the
 * file's own 0.01 m quantum. Relative to the cloud origin the same points
 * reconstruct to 2.3e-4 m. Hence: emit relative, ship the origin in float64.
 */
export interface PointPositionFrame {
  readonly format: PositionFormat;
  /** float64, absolute CRS. Identical for every node under `"cloud"`. */
  readonly origin: Vec3;
  /** `[1,1,1]` for `"float32"`, `metadata.scale` for `"int32"`. */
  readonly scale: Vec3;
  readonly originPolicy: OriginPolicy;
  /**
   * Exact UPPER BOUND on |reconstructed - true| for this node, in CRS units.
   * Computed A PRIORI from the node box — half a float32 ULP at the largest
   * magnitude the box can produce, widened by one quantum because decoded values
   * may sit up to 0.94 quanta outside the box. Never derived from the data, so
   * it is valid before the first point is read. `0` for `"int32"`.
   */
  readonly maxPositionError: number;
}

/**
 * No `BigInt64Array`: int64/uint64 are in core's `UNDECODABLE_ATTRIBUTE_TYPES`
 * and never reach an output.
 */
export type DecodedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

/**
 * A WebGPU vertex format, reported so a renderer can bind an emitted array
 * without re-deriving legality — and so a build can fail when an array is not
 * bindable rather than a demo discovering it.
 *
 * Deliberately a short closed list. WebGPU has NO 3-component or 1-component
 * 8/16-bit vertex format, which is why {@link DecodedAttribute.gpuFormat} is
 * `undefined` for a native-width `Uint8Array` classification or a `Uint16Array`
 * intensity, and why {@link PointDataOptions.scalarFormat} exists.
 */
export type GpuVertexFormat =
  | "float32"
  | "float32x2"
  | "float32x3"
  | "float32x4"
  | "sint32"
  | "sint32x2"
  | "sint32x3"
  | "sint32x4"
  | "uint32"
  | "uint32x2"
  | "uint32x3"
  | "uint32x4"
  | "uint8x4"
  | "unorm8x4"
  | "sint8x4"
  | "snorm8x4"
  | "uint16x2"
  | "uint16x4"
  | "unorm16x2"
  | "unorm16x4"
  | "sint16x2"
  | "sint16x4";

/**
 * How a `numElements === 1` attribute is widened under `scalarFormat: "gpu"`.
 *
 * - `"u32"` — zero-extended. Exact for every unsigned type up to 32 bits.
 * - `"i32"` — sign-extended. Exact for int8/int16/int32, and the correct choice
 *   for an unsigned type whose declared `min` is negative — a real stock
 *   converter output: autzen's `"scan angle rank"` is uint8 with `min: [-21]`.
 * - `"f32"` — float32, applying {@link PointAttribute.normalization} when Task 2
 *   computed one, otherwise the raw value.
 */
export type ScalarLane = "u32" | "i32" | "f32";

/** One decoded non-position, non-colour attribute. */
export interface DecodedAttribute {
  /** VERBATIM manifest name: `"gps-time"`, `"scan angle rank"`. */
  readonly name: string;
  /**
   * The Task 2 descriptor, BY REFERENCE and identity-shared across every node of
   * one source. Reach through it for `min`, `max`, `histogram`, `type` and
   * `normalization`, so nothing is duplicated per node.
   */
  readonly source: PointAttribute;
  /**
   * Length `numPoints * itemSize`, elements interleaved. ALL elements are
   * decoded — both reference decoders read element 0 and then advance the full
   * byteSize, silently truncating any multi-element attribute.
   */
  readonly array: DecodedArray;
  readonly itemSize: 1 | 2 | 3 | 4;
  /** `itemSize * array.BYTES_PER_ELEMENT`. */
  readonly byteStride: number;
  /**
   * `undefined` when this array is NOT directly bindable as a WebGPU vertex
   * buffer — every native-width 1- or 3-component 8/16-bit array, because WebGPU
   * has no such format. Pass `scalarFormat: "gpu"` for a defined value.
   */
  readonly gpuFormat: GpuVertexFormat | undefined;
  /**
   * Reconstruct the SOURCE-domain value:
   * `source = array[i] * inverse.scale + inverse.offset`. `undefined` when the
   * array already holds source-domain values. Set only for an `"f32"` lane built
   * from Task 2's `normalization`.
   */
  readonly inverse:
    | { readonly scale: number; readonly offset: number }
    | undefined;
}

/**
 * Decoded colour, always repacked to RGBA. Alpha is filled with `maxValue`; the
 * reference never writes alpha at all and gets away with it only because its
 * shader binds a vec3.
 *
 * The 16->8 narrowing is decided ONCE PER SOURCE from the declared `max`, never
 * per value. The reference's `c > 255 ? c / 256 : c` is a per-scalar guess that
 * is wrong whenever a genuinely 16-bit channel lands at or below 255: measured
 * on demo/data/synthetic it destroys the hue of 213 of 17,500 points (1.22%).
 * Point 54 is raw (176, 17286, 8791) and the reference renders (176, 67, 34),
 * saturated orange, where the truth is (0, 67, 34), dark green.
 */
export interface DecodedColors {
  /** RGBA interleaved, `4 * numPoints`. */
  readonly array: Uint8Array | Uint16Array;
  /** Always defined — colour is always bindable. */
  readonly gpuFormat: GpuVertexFormat;
  /** 255 for a Uint8Array, 65535 for a Uint16Array. What alpha was filled with. */
  readonly maxValue: number;
  /** The largest value the MANIFEST declares, and the input to the shift. */
  readonly declaredMax: number;
  /** 0 or 8. The per-source narrowing actually applied. */
  readonly shift: 0 | 8;
}

/**
 * One node's points. PLAIN DATA — no class, no methods, no getters, because
 * structured clone strips prototypes and this must survive a worker hop.
 *
 * Every array owns FRESH memory and NEVER aliases the input buffer, which may be
 * detached the instant a worker transfers it.
 */
export interface DecodedPointData {
  readonly nodeIndex: number;
  readonly nodeName: string;
  /** Authoritative. Never infer it from `array.length / itemSize`. */
  readonly numPoints: number;

  /** `3 * numPoints`. Interpret via {@link frame}. */
  readonly positions: Float32Array | Int32Array;
  readonly frame: PointPositionFrame;

  /** `undefined` when the source has no colour attribute, or it was deselected. */
  readonly colors: DecodedColors | undefined;

  /**
   * Selected attributes with `role === undefined`, in MANIFEST order. Position
   * and colour have dedicated fields with narrower types and are deliberately
   * not duplicated here.
   */
  readonly attributes: readonly DecodedAttribute[];
  readonly attributesByName: ReadonlyMap<string, DecodedAttribute>;

  /**
   * Decoded extent in ABSOLUTE CRS, from the data. `undefined` unless
   * `computeBounds` was set.
   *
   * NOT the node box and NOT contained by it — 13,004 of 341,989 real brotli
   * points (3.80%, in 106 of 117 nodes) fall outside their derived box by up to
   * 0.94 quanta. Use this for tight culling; use `hierarchy.boundingBoxOf` for
   * addressing.
   */
  readonly bounds: BoundingBox | undefined;

  /**
   * Every distinct output `ArrayBuffer`, exactly once, and NEVER the input
   * buffer. Computed here so no caller walks the object collecting `.buffer` —
   * that walk is exactly where the reference's two workers diverge (the DEFAULT
   * one transfers the INPUT buffer too; the brotli one's equivalent is commented
   * out).
   */
  readonly transferList: readonly ArrayBuffer[];
  /** Sum of `transferList` byte lengths. An accounting unit for Task 6; O(1). */
  readonly byteLength: number;
}

/** `"morton"` only for position and colour under BROTLI. */
export type PointFieldCodec = "scalar" | "morton";

/** One selected field, with every addressing decision pre-resolved. */
export interface PointFieldPlan {
  readonly name: string;
  readonly role: AttributeRole | undefined;
  readonly type: PointAttributeTypeName;
  readonly numElements: number;
  readonly elementSize: number;
  /**
   * Where point 0's value for this field sits.
   * - DEFAULT — `attribute.byteOffset`, the offset within one record.
   * - BROTLI — the PREFIX WIDTH: the sum of `srcWidth` over all PRECEDING
   *   manifest attributes, selected or not. The block base is
   *   `srcOffset * numPoints`, so it depends on `numPoints` and is recomputed
   *   per node, never cached on the layout.
   */
  readonly srcOffset: number;
  /**
   * Source bytes per point for this field.
   * - DEFAULT — always `layout.stride`.
   * - BROTLI — 16 for position (morton), 8 for colour (morton), else
   *   `numElements * elementSize`.
   */
  readonly srcWidth: number;
  readonly codec: PointFieldCodec;
  /** Output components per point. */
  readonly itemSize: 1 | 2 | 3 | 4;
  /** Which array the output is written into. */
  readonly out: "f32" | "i32" | "u32" | "f64" | "i16" | "u16" | "i8" | "u8";
  readonly gpuFormat: GpuVertexFormat | undefined;
  /**
   * Task 2's precomputed float32 packing constants, COPIED VERBATIM and never
   * recomputed. `f32 = (v - offset) * scale`, with the `(max - min) || 1` guard
   * already baked in. Recomputing is exactly how the reference turns the brotli
   * fixture's degenerate gps-time (min === max === 0, potree/potree#909) into an
   * all-NaN buffer.
   */
  readonly pack:
    | { readonly offset: number; readonly scale: number }
    | undefined;
  /** Colour only. 0 or 8, decided once per source from `attribute.max`. */
  readonly shift: 0 | 8;
  /** Colour only. `Math.max(...attribute.max)`. */
  readonly declaredMax: number;
}

/**
 * The whole per-source decode plan, computed ONCE per (source, options) pair.
 *
 * PLAIN DATA and structured-cloneable: post it to a worker once, cache it there
 * by `sourceId`, and every subsequent message is just bytes plus a
 * {@link PointNodeRef}. Deliberately contains no `PointCloudSource` (its
 * `transport.fetch` is a function, so structured clone throws) and no
 * `HierarchyNode` (cyclic).
 */
export interface PointRecordLayout {
  /** `source.urls.octree`. A worker's cache key. */
  readonly sourceId: string;
  readonly isBrotli: boolean;
  /**
   * Bytes per point in the blob the decoder reads.
   * - DEFAULT — `source.bytesPerPoint` (35 autzen, 18 synthetic).
   * - BROTLI — the sum of `srcWidth` over ALL manifest attributes, selected or
   *   not (47 on lion_takanawa, against a manifest `bytesPerPoint` of 41; the
   *   6-byte difference is exactly the morton padding 12->16 and 6->8).
   */
  readonly stride: number;
  /** Selected fields, in manifest order, INCLUDING position and colour. */
  readonly fields: readonly PointFieldPlan[];
  /** Index into `fields`. Position is always present. */
  readonly positionField: number;
  /** Index into `fields`, or `-1`. */
  readonly colorField: number;

  readonly quantScale: Vec3;
  readonly quantOffset: Vec3;
  readonly positionFormat: PositionFormat;
  readonly originPolicy: OriginPolicy;
  /** Resolved for `"cloud"` and `"file"`; `undefined` for `"node"`. */
  readonly origin: Vec3 | undefined;
  readonly computeBounds: boolean;
  /** Output bytes per point across all selected fields. autzen default: 16. */
  readonly bytesPerPointOut: number;

  /**
   * Tolerated anomalies, at most once per code. SOURCE level, so they live here
   * and are NOT copied onto every decoded node — which keeps a per-node worker
   * message small.
   */
  readonly warnings: readonly PointCloudWarning[];
}

/**
 * Everything {@link DecodedPointData} needs and nothing it does not. Structured-
 * cloneable and transferable end to end.
 */
export interface PointDataRequest {
  readonly layout: PointRecordLayout;
  /** DEFAULT: the raw range. BROTLI: the DECOMPRESSED blob. */
  readonly buffer: ArrayBuffer;
  /**
   * Where this node's blob starts inside `buffer`. Never assume 0 — this is what
   * keeps sibling coalescing open for Task 6 without a signature change.
   */
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly node: PointNodeRef;
  /** Resolved per node; equals `layout.origin` unless the policy is `"node"`. */
  readonly origin: Vec3;
  readonly maxPositionError: number;
}

/** What `fetchNodeBytes` returns. */
export interface NodeBytes {
  /** Exactly `node.byteSize` bytes, or length 0 when no request was issued. */
  readonly buffer: ArrayBuffer;
  /** `false` when `byteSize === 0` short-circuited and no request was made. */
  readonly fetched: boolean;
}

/**
 * A brotli decompressor. Sync or async; the cascade accepts either.
 * `expectedByteLength` is `numPoints * layout.stride`, known exactly before
 * decompression, so an implementation can size its output once.
 */
export type BrotliDecompress = (
  input: Uint8Array,
  expectedByteLength: number,
) => Uint8Array | Promise<Uint8Array>;

export interface PointDataOptions {
  /**
   * Which attributes to decode, BY VERBATIM MANIFEST NAME.
   *
   * Default: the position-role attribute plus the colour-role one, and nothing
   * else — 16 B/pt on autzen, 170 MB for all 10,653,336 points, against the
   * reference's 69 B/pt = 735 MB from a 373 MB file.
   *
   * `[]` means position only. `"all"` means every decodable attribute, with
   * int64/uint64 SKIPPED and warned. Position is ALWAYS decoded.
   *
   * An unknown name throws `"unsupported-attribute"` rather than being ignored:
   * a typo'd `"intensty"` that silently yields nothing is a worse bug.
   */
  readonly attributes?: readonly string[] | "all";
  /** `"float32"` (default) or `"int32"` (exactly lossless). */
  readonly positionFormat?: PositionFormat;
  /**
   * `"cloud"` (default) or `"node"`. Ignored, and forced to `"file"`, when
   * `positionFormat === "int32"`.
   */
  readonly origin?: "cloud" | "node";
  /** `"unorm8"` (default) gives Uint8Array RGBA; `"native"` gives Uint16Array. */
  readonly colorFormat?: "unorm8" | "native";
  /**
   * `"native"` (default) — every scalar keeps its source width. Smallest, exact,
   * and what a CPU consumer or a storage-buffer renderer wants.
   *
   * `"gpu"` — every `numElements === 1` attribute is widened to a 4-byte lane so
   * `gpuFormat` is defined for all of them. The default selection is position +
   * colour, both already GPU-legal at native width, so this changes nothing
   * unless scalars are selected.
   */
  readonly scalarFormat?: "native" | "gpu";
  /** Per-attribute lane override under `"gpu"`, keyed by verbatim name. */
  readonly lanes?: Readonly<Record<string, ScalarLane>>;
  /**
   * Fill {@link DecodedPointData.bounds}. Default `false`: it costs six
   * comparisons per point and only a scheduler wants it.
   */
  readonly computeBounds?: boolean;
}

export interface LoadPointDataOptions extends PointDataOptions {
  /**
   * Aborts the octree.bin request. Propagates as the ORIGINAL `DOMException`,
   * unwrapped, exactly as in Tasks 2 and 3.
   */
  readonly signal?: AbortSignal;
  /**
   * Tier 1 of the brotli cascade. Supply this to bring your own decoder and the
   * built-in tiers are never touched. On a browser with no native brotli this is
   * the one-line fix named in the `"brotli-unavailable"` message:
   *
   * ```ts
   * const { brotliDecompress } = await import("@voxelkloud/loader/brotli");
   * await loadPointData(source, node, { decompress: brotliDecompress });
   * ```
   */
  readonly decompress?: BrotliDecompress;
  /** Refuse a node claiming more than this many bytes. Default 64 MiB. */
  readonly maxNodeBytes?: number;
}
