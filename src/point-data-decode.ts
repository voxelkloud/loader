import type { BoundingBox, Vec3 } from "@voxelkloud/core";
import { fail } from "./errors.js";
import { decodeMortonColor, decodeMortonPosition } from "./point-data-morton.js";
import type { MortonTriple } from "./point-data-morton.js";
import type {
  DecodedArray,
  DecodedAttribute,
  DecodedColors,
  DecodedPointData,
  PointDataRequest,
  PointFieldPlan,
  PointNodeRef,
  PointPositionFrame,
  PointRecordLayout,
} from "./point-data-types.js";
import type { PointCloudSource } from "./types.js";

/** Half a float32 ULP at magnitude `v`. */
function halfUlp32(v: number): number {
  if (v === 0) return 0;
  return 2 ** (Math.floor(Math.log2(v)) - 24);
}

/**
 * Bind a node to a layout, resolving the per-node frame.
 *
 * Pure and synchronous. Split out from {@link decodePointData} because the
 * result is structured-cloneable and transferable end to end, which is what lets
 * a worker body be `onmessage = e => postMessage(decodePointData(e.data), ...)`.
 */
export function createPointDataRequest(
  layout: PointRecordLayout,
  node: PointNodeRef,
  bytes: ArrayBuffer,
  byteOffset = 0,
  byteLength = bytes.byteLength - byteOffset,
): PointDataRequest {
  const origin: Vec3 =
    layout.origin ??
    (Object.freeze([node.minX, node.minY, node.minZ]) as unknown as Vec3);

  // Computed A PRIORI from the box, so it is valid before the first point is
  // read: half a float32 ULP at the largest magnitude the box can produce,
  // widened by one quantum because decoded values may sit just outside the box.
  let maxPositionError = 0;
  if (layout.positionFormat === "float32") {
    const lo: [number, number, number] = [node.minX, node.minY, node.minZ];
    const hi: [number, number, number] = [node.maxX, node.maxY, node.maxZ];
    for (let k = 0; k < 3; k++) {
      const q = layout.quantScale[k] as number;
      const m =
        Math.max(
          Math.abs((lo[k] as number) - (origin[k] as number)),
          Math.abs((hi[k] as number) - (origin[k] as number)),
        ) + Math.abs(q);
      const e = halfUlp32(m);
      if (e > maxPositionError) maxPositionError = e;
    }
  }

  return { layout, buffer: bytes, byteOffset, byteLength, node, origin, maxPositionError };
}

/**
 * Decode one node's points.
 *
 * PURE and SYNCHRONOUS: no I/O, no globals, no clock. Every output array owns
 * fresh memory and never aliases the input buffer, which may be detached the
 * instant a worker transfers it.
 *
 * @throws {VoxelkloudError} `"decode-error"`.
 */
export function decodePointData(
  request: PointDataRequest,
  source?: PointCloudSource,
): DecodedPointData {
  const { layout, node, origin } = request;
  const numPoints = node.numPoints;

  // ── length identity, FIRST, before any read ─────────────────────────────
  // This is the check the reference does not have: it calls response
  // .arrayBuffer() without inspecting status or length, so a host that ignores
  // Range hands back the whole file and the decoder reads the first numPoints
  // records from byte 0 of the FILE rather than of the node — wrong geometry,
  // no error. It is also the ONLY thing that catches an over-wide brotli
  // response, because a stream with trailing zeros decompresses successfully.
  const expected = numPoints * layout.stride;
  if (request.byteLength !== expected) {
    fail(
      "decode-error",
      `${node.name}: expected ${expected} bytes for ${numPoints} points at ` +
        `${layout.stride} bytes each, received ${request.byteLength}.`,
      { path: node.name },
    );
  }

  const positions =
    layout.positionFormat === "int32"
      ? new Int32Array(3 * numPoints)
      : new Float32Array(3 * numPoints);

  let colors: DecodedColors | undefined;
  const attributes: DecodedAttribute[] = [];
  const attributesByName = new Map<string, DecodedAttribute>();
  const transferList: ArrayBuffer[] = [positions.buffer as ArrayBuffer];
  let bounds: BoundingBox | undefined;

  if (numPoints > 0) {
    const dv = new DataView(request.buffer, request.byteOffset, request.byteLength);
    const morton: MortonTriple = { x: 0, y: 0, z: 0 };

    for (const field of layout.fields) {
      const base = layout.isBrotli ? field.srcOffset * numPoints : field.srcOffset;

      if (field.role === "position") {
        bounds = decodePositions(
          dv,
          field,
          layout,
          numPoints,
          base,
          origin,
          positions,
          morton,
        );
        continue;
      }

      if (field.role === "color") {
        colors = decodeColors(dv, field, layout, numPoints, base, morton);
        transferList.push(colors.array.buffer as ArrayBuffer);
        continue;
      }

      const array = decodeGeneric(dv, field, layout, numPoints, base);
      const attribute: DecodedAttribute = {
        name: field.name,
        source: source?.attributesByName.get(field.name) as never,
        array,
        itemSize: field.itemSize,
        byteStride: field.itemSize * array.BYTES_PER_ELEMENT,
        gpuFormat: field.gpuFormat,
        inverse:
          field.pack === undefined
            ? undefined
            : { scale: 1 / field.pack.scale, offset: field.pack.offset },
      };
      attributes.push(attribute);
      attributesByName.set(field.name, attribute);
      transferList.push(array.buffer as ArrayBuffer);
    }
  }

  const frame: PointPositionFrame = Object.freeze({
    format: layout.positionFormat,
    origin,
    scale:
      layout.positionFormat === "int32"
        ? layout.quantScale
        : (Object.freeze([1, 1, 1]) as unknown as Vec3),
    originPolicy: layout.originPolicy,
    maxPositionError: request.maxPositionError,
  });

  let byteLength = 0;
  for (const b of transferList) byteLength += b.byteLength;

  return {
    nodeIndex: node.index,
    nodeName: node.name,
    numPoints,
    positions,
    frame,
    colors,
    attributes,
    attributesByName,
    bounds,
    transferList,
    byteLength,
  };
}

function decodePositions(
  dv: DataView,
  field: PointFieldPlan,
  layout: PointRecordLayout,
  numPoints: number,
  base: number,
  origin: Vec3,
  out: Float32Array | Int32Array,
  morton: MortonTriple,
): BoundingBox | undefined {
  const raw = layout.positionFormat === "int32";
  // Position ignores its OWN scale/offset — [1,1,1]/[0,0,0] in both real
  // manifests, decoys. The real quantization is the top-level metadata pair.
  // Folding -origin into the bias keeps the huge cancellation to one float64
  // subtraction per node rather than one per point.
  const sx = layout.quantScale[0];
  const sy = layout.quantScale[1];
  const sz = layout.quantScale[2];
  const bx = layout.quantOffset[0] - origin[0];
  const by = layout.quantOffset[1] - origin[1];
  const bz = layout.quantOffset[2] - origin[2];

  const track = layout.computeBounds;
  let loX = Infinity;
  let loY = Infinity;
  let loZ = Infinity;
  let hiX = -Infinity;
  let hiY = -Infinity;
  let hiZ = -Infinity;

  const morton16 = field.codec === "morton";
  const es = field.elementSize;
  const signed = field.type.startsWith("int");

  for (let j = 0, w = 0; j < numPoints; j++, w += 3) {
    let X: number;
    let Y: number;
    let Z: number;

    if (morton16) {
      decodeMortonPosition(dv, base + j * 16, morton);
      X = morton.x;
      Y = morton.y;
      Z = morton.z;
    } else {
      const o = base + j * field.srcWidth;
      if (es === 4 && signed) {
        X = dv.getInt32(o, true);
        Y = dv.getInt32(o + 4, true);
        Z = dv.getInt32(o + 8, true);
      } else {
        X = readScalar(dv, o, field);
        Y = readScalar(dv, o + es, field);
        Z = readScalar(dv, o + 2 * es, field);
      }
    }

    if (raw) {
      if (X >= 2 ** 31 || Y >= 2 ** 31 || Z >= 2 ** 31) {
        fail(
          "decode-error",
          `Position component ${Math.max(X, Y, Z)} exceeds the Int32Array ` +
            `range; use positionFormat "float32".`,
        );
      }
      out[w] = X;
      out[w + 1] = Y;
      out[w + 2] = Z;
    } else {
      // Every intermediate is float64; the Float32Array store is the SINGLE
      // rounding. Math.fround intermediates would round twice.
      out[w] = X * sx + bx;
      out[w + 1] = Y * sy + by;
      out[w + 2] = Z * sz + bz;
    }

    if (track) {
      const ax = X * sx + layout.quantOffset[0];
      const ay = Y * sy + layout.quantOffset[1];
      const az = Z * sz + layout.quantOffset[2];
      if (ax < loX) loX = ax;
      if (ay < loY) loY = ay;
      if (az < loZ) loZ = az;
      if (ax > hiX) hiX = ax;
      if (ay > hiY) hiY = ay;
      if (az > hiZ) hiZ = az;
    }
  }

  if (!track || numPoints === 0) return undefined;
  return Object.freeze({
    min: Object.freeze([loX, loY, loZ]) as unknown as Vec3,
    max: Object.freeze([hiX, hiY, hiZ]) as unknown as Vec3,
  });
}

function decodeColors(
  dv: DataView,
  field: PointFieldPlan,
  layout: PointRecordLayout,
  numPoints: number,
  base: number,
  morton: MortonTriple,
): DecodedColors {
  const wide = field.out === "u16";
  const array = wide ? new Uint16Array(4 * numPoints) : new Uint8Array(4 * numPoints);
  const maxValue = wide ? 65535 : 255;
  const shift = field.shift;
  const isMorton = field.codec === "morton";
  const es = field.elementSize;
  const n = field.numElements;

  for (let j = 0, w = 0; j < numPoints; j++, w += 4) {
    let r: number;
    let g: number;
    let b: number;
    let a = -1;

    if (isMorton) {
      decodeMortonColor(dv, base + j * 8, morton);
      r = morton.x;
      g = morton.y;
      b = morton.z;
    } else {
      // Read through the DECLARED type. The reference hardcodes getUint16
      // regardless, so a uint8 rgb manifest decodes to garbage there: every
      // read straddles two channels while the stride advance uses byteSize 3.
      const o = base + j * field.srcWidth;
      r = readScalar(dv, o, field);
      g = readScalar(dv, o + es, field);
      b = readScalar(dv, o + 2 * es, field);
      if (n >= 4) a = readScalar(dv, o + 3 * es, field);
    }

    // The saturate only bites when shift === 0, turning a lying manifest into
    // clipped-bright rather than the silent mod-256 hue destruction a bare
    // Uint8Array store would give.
    array[w] = Math.min(r >>> shift, maxValue);
    array[w + 1] = Math.min(g >>> shift, maxValue);
    array[w + 2] = Math.min(b >>> shift, maxValue);
    array[w + 3] = a < 0 ? maxValue : Math.min(a >>> shift, maxValue);
  }

  return {
    array,
    gpuFormat: wide ? "uint16x4" : "unorm8x4",
    maxValue,
    declaredMax: field.declaredMax,
    shift,
  };
}

function decodeGeneric(
  dv: DataView,
  field: PointFieldPlan,
  layout: PointRecordLayout,
  numPoints: number,
  base: number,
): DecodedArray {
  const n = field.numElements;
  const array = makeArray(field.out, numPoints * n);
  const es = field.elementSize;
  const pack = field.pack;

  for (let j = 0, o = base, w = 0; j < numPoints; j++, o += field.srcWidth) {
    for (let e = 0; e < n; e++, w++) {
      const v = readScalar(dv, o + e * es, field);
      array[w] = pack === undefined ? v : (v - pack.offset) * pack.scale;
    }
  }
  return array;
}

/** Read one source-typed scalar. */
function readScalar(dv: DataView, at: number, field: PointFieldPlan): number {
  switch (field.type) {
    case "int8":
      return dv.getInt8(at);
    case "uint8":
      return dv.getUint8(at);
    case "int16":
      return dv.getInt16(at, true);
    case "uint16":
      return dv.getUint16(at, true);
    case "int32":
      return dv.getInt32(at, true);
    case "uint32":
      return dv.getUint32(at, true);
    case "float":
      return dv.getFloat32(at, true);
    case "double":
      return dv.getFloat64(at, true);
    default:
      // int64/uint64 are filtered out at layout time.
      fail("decode-error", `Cannot read attribute type ${field.type}.`);
  }
}

function makeArray(out: PointFieldPlan["out"], length: number): DecodedArray {
  switch (out) {
    case "i8":
      return new Int8Array(length);
    case "u8":
      return new Uint8Array(length);
    case "i16":
      return new Int16Array(length);
    case "u16":
      return new Uint16Array(length);
    case "i32":
      return new Int32Array(length);
    case "u32":
      return new Uint32Array(length);
    case "f32":
      return new Float32Array(length);
    case "f64":
      return new Float64Array(length);
  }
}
