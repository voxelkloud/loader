import { POINT_ATTRIBUTE_TYPE_SIZE, UNDECODABLE_ATTRIBUTE_TYPES } from "@voxelkloud/core";
import type { PointAttributeTypeName, Vec3 } from "@voxelkloud/core";
import { fail } from "./errors.js";
import type {
  GpuVertexFormat,
  OriginPolicy,
  PointDataOptions,
  PointFieldPlan,
  PointRecordLayout,
  PositionFormat,
  ScalarLane,
} from "./point-data-types.js";
import type {
  PointAttribute,
  PointCloudSource,
  PointCloudWarning,
  PointCloudWarningCode,
} from "./types.js";

/** BROTLI stores positions as a 16-byte morton record, not 3 int32. */
const BROTLI_POSITION_WIDTH = 16;
/** BROTLI stores colour as an 8-byte morton record, not 3 uint16. */
const BROTLI_COLOR_WIDTH = 8;

/** float32 has a 24-bit mantissa; beyond this a quantum is not representable. */
const FLOAT32_MANTISSA_LIMIT = 2 ** 23;

type OutKind = PointFieldPlan["out"];

const OUT_FOR_TYPE: Record<PointAttributeTypeName, OutKind> = {
  int8: "i8",
  uint8: "u8",
  int16: "i16",
  uint16: "u16",
  int32: "i32",
  uint32: "u32",
  float: "f32",
  double: "f64",
  // Never reached: these are filtered by UNDECODABLE_ATTRIBUTE_TYPES.
  int64: "f64",
  uint64: "f64",
};

/**
 * WebGPU vertex formats, by (output array kind, component count).
 *
 * The gaps are the point: WebGPU has NO 1- or 3-component 8/16-bit vertex
 * format, so a native-width Uint8Array classification or Uint16Array intensity
 * is simply not bindable, and `gpuFormat` is `undefined` there rather than a
 * lie.
 */
const GPU_FORMAT: Partial<Record<OutKind, Partial<Record<number, GpuVertexFormat>>>> = {
  f32: { 1: "float32", 2: "float32x2", 3: "float32x3", 4: "float32x4" },
  i32: { 1: "sint32", 2: "sint32x2", 3: "sint32x3", 4: "sint32x4" },
  u32: { 1: "uint32", 2: "uint32x2", 3: "uint32x3", 4: "uint32x4" },
  u8: { 4: "uint8x4" },
  i8: { 4: "sint8x4" },
  u16: { 2: "uint16x2", 4: "uint16x4" },
  i16: { 2: "sint16x2", 4: "sint16x4" },
};

function gpuFormatFor(out: OutKind, itemSize: number): GpuVertexFormat | undefined {
  return GPU_FORMAT[out]?.[itemSize];
}

const BYTES_FOR_OUT: Record<OutKind, number> = {
  i8: 1,
  u8: 1,
  i16: 2,
  u16: 2,
  i32: 4,
  u32: 4,
  f32: 4,
  f64: 8,
};

/**
 * Build the per-source decode plan.
 *
 * Pure and synchronous, no I/O. Compute it ONCE per (source, options) pair and
 * reuse it for every node: it is the only place attribute selection, addressing,
 * the colour narrowing and the coordinate frame are decided, and it is plain
 * data, so a worker can cache it by `sourceId`.
 *
 * @throws {VoxelkloudError} `"unsupported-encoding"`, `"unsupported-attribute"`.
 */
export function createPointLayout(
  source: PointCloudSource,
  options: PointDataOptions = {},
): PointRecordLayout {
  const warnings: PointCloudWarning[] = [];
  const emitted = new Set<PointCloudWarningCode>();
  const warn = (
    code: PointCloudWarningCode,
    path: string,
    message: string,
  ): void => {
    if (emitted.has(code)) return;
    emitted.add(code);
    warnings.push({ code, path, message });
  };

  // ── 0.1 encoding ────────────────────────────────────────────────────────
  const encoding = source.metadata.encoding;
  const isBrotli = encoding === "BROTLI";
  if (!isBrotli && encoding !== "DEFAULT" && encoding !== "UNCOMPRESSED") {
    fail(
      "unsupported-encoding",
      `Cannot decode point data with encoding ${JSON.stringify(encoding)}. ` +
        `@voxelkloud/loader reads "DEFAULT", "UNCOMPRESSED" and "BROTLI".`,
      { path: "encoding" },
    );
  }

  // ── 0.2 selection ───────────────────────────────────────────────────────
  const position = source.attributes.find((a) => a.role === "position");
  if (position === undefined) {
    fail(
      "unsupported-attribute",
      `This point cloud declares no position attribute (expected one named ` +
        `"position" or "POSITION_CARTESIAN"), so its points cannot be placed.`,
      { path: "attributes" },
    );
  }
  if (position.numElements !== 3) {
    fail(
      "unsupported-attribute",
      `The position attribute declares numElements ${position.numElements}; ` +
        `expected 3.`,
      { path: "attributes" },
    );
  }
  if (position.type !== "int32") {
    warn(
      "unexpected-position-type",
      position.name,
      `The position attribute has type ${position.type}, not int32. It will ` +
        `be read through its declared type; the reference decoder hardcodes ` +
        `int32 and would misread it.`,
    );
  }

  const color = source.attributes.find((a) => a.role === "color");
  const selected = resolveSelection(source, position, color, options, warn);

  // ── 0.3/0.4 addressing ──────────────────────────────────────────────────
  // Under BROTLI the on-disk stride spans ALL manifest attributes, selected or
  // not: deselecting does not compact the blob.
  const allWidths = source.attributes.map((a) => brotliWidth(a));
  const prefix: number[] = [];
  let running = 0;
  for (const w of allWidths) {
    prefix.push(running);
    running += w;
  }
  const stride = isBrotli ? running : source.bytesPerPoint;

  const scalarFormat = options.scalarFormat ?? "native";
  const colorFormat = options.colorFormat ?? "unorm8";

  const fields: PointFieldPlan[] = [];
  let positionField = -1;
  let colorField = -1;
  let bytesPerPointOut = 0;

  source.attributes.forEach((attribute, i) => {
    if (!selected.has(attribute.name)) return;

    const isPosition = attribute === position;
    const isColor = color !== undefined && attribute === color;
    const codec = isBrotli && (isPosition || isColor) ? "morton" : "scalar";

    let out: OutKind;
    let itemSize: 1 | 2 | 3 | 4;
    let pack: { offset: number; scale: number } | undefined;
    let shift: 0 | 8 = 0;
    let declaredMax = 0;

    if (isPosition) {
      out = (options.positionFormat ?? "float32") === "int32" ? "i32" : "f32";
      itemSize = 3;
    } else if (isColor) {
      out = colorFormat === "native" ? "u16" : "u8";
      itemSize = 4;
      declaredMax = Math.max(...attribute.max);
      shift = colorShift(attribute, colorFormat, warn);
    } else {
      itemSize = attribute.numElements as 1 | 2 | 3 | 4;
      if (scalarFormat === "gpu" && attribute.numElements === 1) {
        const lane = laneFor(attribute, options.lanes?.[attribute.name]);
        out = lane === "u32" ? "u32" : lane === "i32" ? "i32" : "f32";
        if (lane === "f32" && attribute.normalization !== undefined) {
          // Task 2's constants, copied verbatim. Recomputing is exactly how the
          // reference turns a degenerate range into an all-NaN buffer.
          pack = { ...attribute.normalization };
        }
      } else {
        out = OUT_FOR_TYPE[attribute.type];
      }
      if (isBrotli && attribute.numElements > 1) {
        warn(
          "unverified-brotli-attribute",
          attribute.name,
          `Attribute ${JSON.stringify(attribute.name)} has ${attribute.numElements} ` +
            `elements under BROTLI. Only position and colour are known to be ` +
            `special-cased by the converter, so a plain ` +
            `numElements * elementSize width is assumed; if that is wrong the ` +
            `length check will fail loudly rather than return shifted garbage.`,
        );
      }
    }

    const plan: PointFieldPlan = {
      name: attribute.name,
      role: attribute.role,
      type: attribute.type,
      numElements: attribute.numElements,
      elementSize: attribute.elementSize,
      srcOffset: isBrotli ? prefix[i]! : attribute.byteOffset,
      srcWidth: isBrotli ? allWidths[i]! : stride,
      codec,
      itemSize,
      out,
      // Colour binds as NORMALIZED — a shader wants 0..1, not 0..255 — so it
      // does not come from the generic (kind, count) table, which would report
      // the integer format and silently disagree with what the decoder emits.
      gpuFormat: isColor
        ? colorFormat === "native"
          ? "uint16x4"
          : "unorm8x4"
        : gpuFormatFor(out, itemSize),
      pack,
      shift,
      declaredMax,
    };

    if (isPosition) positionField = fields.length;
    if (isColor) colorField = fields.length;
    fields.push(plan);
    bytesPerPointOut += itemSize * BYTES_FOR_OUT[out];
  });

  // ── 0.6 frame ───────────────────────────────────────────────────────────
  const positionFormat: PositionFormat = options.positionFormat ?? "float32";
  // int32 emits the stored integers verbatim, and those are quantized about
  // metadata.offset — re-basing them would need a non-integer shift.
  const originPolicy: OriginPolicy =
    positionFormat === "int32" ? "file" : (options.origin ?? "cloud");

  const box = source.metadata.boundingBox;
  const origin: Vec3 | undefined =
    originPolicy === "file"
      ? source.metadata.offset
      : originPolicy === "cloud"
        ? box.min
        : undefined;

  if (positionFormat === "float32") {
    const side = Math.max(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2],
    );
    const minScale = Math.min(...source.metadata.scale.map(Math.abs));
    const ratio = minScale > 0 ? side / minScale : Infinity;
    if (ratio > FLOAT32_MANTISSA_LIMIT) {
      const worst = 2 ** (Math.ceil(Math.log2(side)) - 24);
      warn(
        "position-precision-degraded",
        "boundingBox",
        `This cloud spans ${side.toFixed(2)} units at a quantization step of ` +
          `${minScale}, a ratio of 2^${Math.log2(ratio).toFixed(2)}, which ` +
          `exceeds float32's 24-bit mantissa. Positions may lose up to ` +
          `${worst.toExponential(4)} units. Use positionFormat: "int32" for ` +
          `exact values, or origin: "node" to recover precision per node.`,
      );
    }
  }

  return {
    sourceId: source.urls.octree,
    isBrotli,
    stride,
    fields,
    positionField,
    colorField,
    quantScale: source.metadata.scale,
    quantOffset: source.metadata.offset,
    positionFormat,
    originPolicy,
    origin,
    computeBounds: options.computeBounds ?? false,
    bytesPerPointOut,
    warnings,
  };
}

function brotliWidth(a: PointAttribute): number {
  if (a.role === "position") return BROTLI_POSITION_WIDTH;
  if (a.role === "color") return BROTLI_COLOR_WIDTH;
  return a.numElements * a.elementSize;
}

/**
 * The 16->8 colour narrowing, decided ONCE from the DECLARED max.
 *
 * The reference's `c > 255 ? c / 256 : c` is a per-scalar, per-point guess that
 * is wrong exactly when a genuinely 16-bit channel lands at or below 255 — the
 * darkest 0.4% of the range. On demo/data/synthetic that destroys the hue of
 * 213 of 17,500 points: point 54 is raw (176, 17286, 8791) and the reference
 * renders saturated orange where the truth is dark green.
 *
 * A uint16 attribute declaring max <= 255 is NOT warned about, even though it is
 * formally ambiguous between 8-bit-stored-in-16 and a very dark 16-bit source.
 * autzen is exactly that case and it is stock converter output, so warning would
 * fire on a large share of clean real clouds — and the warning would carry no
 * actionable content, because passthrough is the right answer under BOTH
 * readings: exact for 8-bit-in-16, and relative-value-preserving for a dark
 * 16-bit source, where shifting would instead crush every channel to zero.
 */
function colorShift(
  attribute: PointAttribute,
  colorFormat: "unorm8" | "native",
  warn: (c: PointCloudWarningCode, p: string, m: string) => void,
): 0 | 8 {
  if (attribute.type !== "uint8" && attribute.type !== "uint16") {
    warn(
      "unexpected-color-type",
      attribute.name,
      `The colour attribute has type ${attribute.type}; expected uint8 or ` +
        `uint16. It is read through its declared type without narrowing.`,
    );
    return 0;
  }
  if (colorFormat === "native") return 0;
  if (attribute.elementSize !== 2) return 0;
  return Math.max(...attribute.max) > 255 ? 8 : 0;
}

/**
 * Which 4-byte lane a scalar takes under `scalarFormat: "gpu"`.
 *
 * An unsigned type whose DECLARED min is negative takes the signed lane: autzen
 * ships `"scan angle rank"` as uint8 with `min: [-21]`, and its raw bytes really
 * are two's-complement.
 */
function laneFor(
  attribute: PointAttribute,
  override: ScalarLane | undefined,
): ScalarLane {
  if (override !== undefined) return override;
  if (attribute.type === "float" || attribute.type === "double") return "f32";
  const signed =
    attribute.type === "int8" ||
    attribute.type === "int16" ||
    attribute.type === "int32" ||
    attribute.min.some((v) => v < 0);
  return signed ? "i32" : "u32";
}

function resolveSelection(
  source: PointCloudSource,
  position: PointAttribute,
  color: PointAttribute | undefined,
  options: PointDataOptions,
  warn: (c: PointCloudWarningCode, p: string, m: string) => void,
): Set<string> {
  const wanted = options.attributes;
  const out = new Set<string>([position.name]);

  if (wanted === undefined) {
    if (color !== undefined) out.add(color.name);
    return out;
  }

  if (wanted === "all") {
    for (const a of source.attributes) {
      if (UNDECODABLE_ATTRIBUTE_TYPES.has(a.type)) {
        warn(
          "undecodable-attribute-type",
          a.name,
          `Skipping attribute ${JSON.stringify(a.name)}: type ${a.type} has no ` +
            `lossless JavaScript representation. Name it explicitly to get an ` +
            `error instead of a skip.`,
        );
        continue;
      }
      out.add(a.name);
    }
    return out;
  }

  for (const name of wanted) {
    const a = source.attributesByName.get(name);
    if (a === undefined) {
      fail(
        "unsupported-attribute",
        `No attribute named ${JSON.stringify(name)}. This cloud has: ` +
          `${source.attributes.map((x) => JSON.stringify(x.name)).join(", ")}.`,
        { path: name },
      );
    }
    if (UNDECODABLE_ATTRIBUTE_TYPES.has(a.type)) {
      fail(
        "unsupported-attribute",
        `Attribute ${JSON.stringify(name)} has type ${a.type}, which has no ` +
          `lossless JavaScript representation and cannot be decoded.`,
        { path: name },
      );
    }
    if (a.numElements > 4) {
      fail(
        "unsupported-attribute",
        `Attribute ${JSON.stringify(name)} has ${a.numElements} elements; at ` +
          `most 4 are supported.`,
        { path: name },
      );
    }
    out.add(name);
  }
  return out;
}

export { POINT_ATTRIBUTE_TYPE_SIZE };
