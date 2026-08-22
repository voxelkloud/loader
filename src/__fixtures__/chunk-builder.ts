// TEST-ONLY code (not data). Builds synthetic hierarchy.bin bytes.
//
// This is the ONLY way to reach the pathological cases, because valid converter
// output cannot produce them — most importantly potree/potree#1125
// (`byteSize === 0` with `numPoints > 0`), which occurs 0 times across all three
// fixtures (autzen's 47 zero-byteSize records all already report 0 points).

import {
  HIERARCHY_NODE_BYTE_SIZE as REC,
  HierarchyNodeType,
} from "@voxelkloud/core";
import type { HierarchyNodeRecord } from "@voxelkloud/core";

export type PartialRecord = Partial<HierarchyNodeRecord>;

function record(r: PartialRecord): HierarchyNodeRecord {
  return {
    type: r.type ?? HierarchyNodeType.Normal,
    childMask: r.childMask ?? 0,
    numPoints: r.numPoints ?? 0,
    byteOffset: r.byteOffset ?? 0,
    byteSize: r.byteSize ?? 0,
  };
}

function writeI64(view: DataView, at: number, value: number): void {
  // Split into two LE uint32s so a value above 2^32 round-trips, and so a test
  // can plant a high word directly via `rawHigh`.
  const lo = value >>> 0;
  const hi = Math.floor(value / 4294967296);
  view.setUint32(at, lo, true);
  view.setUint32(at + 4, hi >>> 0, true);
}

/** Serialise records into one chunk's worth of 22-byte entries. */
export function buildChunk(records: PartialRecord[]): Uint8Array {
  const out = new Uint8Array(records.length * REC);
  const view = new DataView(out.buffer);
  records.forEach((raw, i) => {
    const r = record(raw);
    const o = i * REC;
    view.setUint8(o, r.type);
    view.setUint8(o + 1, r.childMask);
    view.setUint32(o + 2, r.numPoints, true);
    writeI64(view, o + 6, r.byteOffset);
    writeI64(view, o + 14, r.byteSize);
  });
  return out;
}

export interface ChunkPlacement {
  readonly byteOffset: number;
  readonly records: PartialRecord[];
}

/**
 * Place chunks at explicit absolute offsets, so cycles, out-of-range pointers
 * and orphan bytes are all expressible. Gaps are zero-filled.
 */
export function buildFile(chunks: ChunkPlacement[]): Uint8Array {
  let end = 0;
  for (const c of chunks) {
    end = Math.max(end, c.byteOffset + c.records.length * REC);
  }
  const out = new Uint8Array(end);
  for (const c of chunks) out.set(buildChunk(c.records), c.byteOffset);
  return out;
}

/** Overwrite the raw high word of a record's i64, for u53-bound tests. */
export function setRawHigh(
  bytes: Uint8Array,
  recordIndex: number,
  field: "byteOffset" | "byteSize",
  high: number,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = recordIndex * REC + (field === "byteOffset" ? 6 : 14) + 4;
  view.setUint32(at, high >>> 0, true);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
