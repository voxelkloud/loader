import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_NODES,
  fixtureSource,
  loadFixtureHierarchy,
  loadFixtureOctree,
} from "./__fixtures__/index.js";
import { isVoxelkloudError } from "./errors.js";
import { createHierarchy } from "./hierarchy.js";
import { decompressNodeBytes } from "./point-data-brotli.js";
import { createPointDataRequest, decodePointData } from "./point-data-decode.js";
import { createPointLayout } from "./point-data-layout.js";
import { dealign24b } from "./point-data-morton.js";
import type { OctreeSliceName } from "./__fixtures__/index.js";
import type { PointNodeRef } from "./point-data-types.js";

const SLICES = ["brotli.r10", "brotli.r11", "brotli.r37"] as const;

function nodeFor(slice: OctreeSliceName): PointNodeRef {
  const meta = FIXTURE_NODES[slice];
  const h = createHierarchy(fixtureSource("brotli"), {
    buffer: loadFixtureHierarchy("brotli"),
  });
  h.tryExpandSync(h.root);
  let node = h.root;
  for (let i = 1; i < meta.name.length; i++) {
    h.tryExpandSync(node);
    const child = node.children[meta.name.charCodeAt(i) - 48];
    if (child === undefined) break;
    node = child;
  }
  return {
    index: node.index,
    name: node.name,
    numPoints: meta.numPoints,
    byteOffset: 0,
    byteSize: meta.byteSize,
    minX: node.minX,
    minY: node.minY,
    minZ: node.minZ,
    maxX: node.maxX,
    maxY: node.maxY,
    maxZ: node.maxZ,
  };
}

async function decodeSlice(slice: OctreeSliceName, options = {}) {
  const source = fixtureSource("brotli");
  const layout = createPointLayout(source, options);
  const node = nodeFor(slice);
  const blob = await decompressNodeBytes(
    layout,
    loadFixtureOctree(slice),
    node.numPoints,
  );
  return {
    source,
    layout,
    node,
    result: decodePointData(createPointDataRequest(layout, node, blob), source),
  };
}

/** Bigint morton encoder — an oracle independent of the decoder under test. */
function mortonEncode(x: number, y: number, z: number): bigint {
  let r = 0n;
  for (let i = 0n; i < 32n; i++) {
    r |= ((BigInt(x) >> i) & 1n) << (3n * i);
    r |= ((BigInt(y) >> i) & 1n) << (3n * i + 1n);
    r |= ((BigInt(z) >> i) & 1n) << (3n * i + 2n);
  }
  return r;
}

/** Lay a morton triple out the way the converter does: 2 words, 8 bytes each. */
function writeMortonPosition(x: number, y: number, z: number): ArrayBuffer {
  const m = mortonEncode(x, y, z);
  const lo = m & 0xffffffffffffn;
  const hi = (m >> 48n) & 0xffffffffffffn;
  const buf = new ArrayBuffer(16);
  const dv = new DataView(buf);
  dv.setUint32(0, Number(hi & 0xffffffffn), true);
  dv.setUint32(4, Number((hi >> 32n) & 0xffffffffn), true);
  dv.setUint32(8, Number(lo & 0xffffffffn), true);
  dv.setUint32(12, Number((lo >> 32n) & 0xffffffffn), true);
  return buf;
}

describe("brotli: dealign24b", () => {
  // The one piece of the decoder with a bit-exact external oracle.
  it("matches a bigint morton encoder across the single-axis domain", () => {
    let mismatches = 0;
    for (let v = 0; v < 8192; v++) {
      const m = mortonEncode(v, 0, 0);
      const low24 = Number(m & 0xffffffn);
      if (dealign24b(low24) !== (v & 0xff)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it("extracts each axis from an interleaved triple", () => {
    const m = mortonEncode(0xab, 0xcd, 0xef);
    const low24 = Number(m & 0xffffffn);
    expect(dealign24b(low24)).toBe(0xab);
    expect(dealign24b(low24 >>> 1)).toBe(0xcd);
    expect(dealign24b(low24 >>> 2)).toBe(0xef);
  });
});

describe("brotli: the dropped high-bits guard", () => {
  /**
   * The reference gates its high dwords on `mc_1 != 0 || mc_2 != 0`. `mc_2` is
   * the high dword of the LOW word — bits 8..15, already consumed — so testing
   * it is merely over-conservative. The dword NEVER tested is `mc_0`, which
   * carries bits 27..31, so a coordinate that lives only up there is silently
   * discarded. The real fixture cannot catch this (0 of 341,989 points have a
   * non-zero mc_0), which is exactly why the guard had to go rather than be
   * trusted.
   */
  it("recovers a coordinate that lives only in bits 27..31", async () => {
    const source = fixtureSource("brotli");
    const layout = createPointLayout(source, { attributes: [] });
    const value = 2 ** 27;

    // One point, position block only — the other blocks are zero-filled.
    const blob = new Uint8Array(layout.stride);
    blob.set(new Uint8Array(writeMortonPosition(value, 0, 0)), 0);

    const node: PointNodeRef = {
      index: 0,
      name: "r",
      numPoints: 1,
      byteOffset: 0,
      byteSize: blob.byteLength,
      minX: -Infinity,
      minY: -Infinity,
      minZ: -Infinity,
      maxX: Infinity,
      maxY: Infinity,
      maxZ: Infinity,
    };
    const r = decodePointData(
      createPointDataRequest(
        createPointLayout(source, { attributes: [], positionFormat: "int32" }),
        node,
        blob.buffer as ArrayBuffer,
      ),
      source,
    );
    expect(r.positions[0]).toBe(value);
    expect(r.positions[1]).toBe(0);
    expect(r.positions[2]).toBe(0);
  });
});

describe("brotli: real converter output", () => {
  it.each(SLICES)("%s decompresses to exactly numPoints * stride", async (s) => {
    const source = fixtureSource("brotli");
    const layout = createPointLayout(source);
    // 47 B/pt against a manifest bytesPerPoint of 41: the 6-byte difference is
    // exactly the morton padding, 12->16 for position and 6->8 for colour.
    expect(layout.stride).toBe(47);
    expect(source.bytesPerPoint).toBe(41);

    const node = nodeFor(s);
    const blob = await decompressNodeBytes(
      layout,
      loadFixtureOctree(s),
      node.numPoints,
    );
    expect(blob.byteLength).toBe(node.numPoints * 47);
  });

  it.each(SLICES)("%s decodes with positions contained", async (s) => {
    const d = await decodeSlice(s);
    const { result: r, node, layout } = d;
    let inside = 0;
    const lo = [node.minX, node.minY, node.minZ];
    const hi = [node.maxX, node.maxY, node.maxZ];
    for (let i = 0; i < r.numPoints; i++) {
      let ok = true;
      for (let k = 0; k < 3; k++) {
        const abs = r.frame.origin[k]! + r.positions[3 * i + k]!;
        const slack = Math.abs(layout.quantScale[k]!) + r.frame.maxPositionError;
        if (abs < lo[k]! - slack || abs > hi[k]! + slack) ok = false;
      }
      if (ok) inside++;
    }
    // One quantum is the canonical tolerance: 3.80% of real brotli points sit
    // up to 0.94 quanta outside their derived box — a converter property, not a
    // decode error — and corrupting the layout drops this to under 37%.
    expect(inside).toBe(r.numPoints);
  });

  // r11 and r37 are 3-point nodes specifically because that puts the int16
  // scan-angle block at byte 69 (ODD) and the double gps-time block at byte 81
  // (not 8-aligned) — neither addressable by a typed-array view, which is why
  // the decoder reads through a DataView.
  it.each(["brotli.r11", "brotli.r37"] as const)(
    "%s decodes misaligned blocks correctly",
    async (s) => {
      const d = await decodeSlice(s, { attributes: "all" });
      const gps = d.result.attributesByName.get("gps-time")!;
      expect(gps.array).toBeInstanceOf(Float64Array);
      const scan = d.result.attributesByName.get("scan angle")!;
      expect(scan.array).toBeInstanceOf(Int16Array);
      // Every value must sit inside its declared range.
      for (const name of ["intensity", "OriginId", "classification"]) {
        const a = d.result.attributesByName.get(name)!;
        const src = d.source.attributesByName.get(name)!;
        for (let i = 0; i < d.result.numPoints; i++) {
          expect(a.array[i]).toBeGreaterThanOrEqual(src.min[0]!);
          expect(a.array[i]).toBeLessThanOrEqual(src.max[0]!);
        }
      }
    },
  );

  it("narrows brotli colour by 8, as its declared max implies", async () => {
    const d = await decodeSlice("brotli.r10");
    const c = d.result.colors!;
    expect(c.declaredMax).toBe(65280);
    expect(c.shift).toBe(8);
    for (let i = 0; i < d.result.numPoints * 4; i++) {
      expect(c.array[i]).toBeLessThanOrEqual(255);
    }
  });

  // lion_takanawa has no GPS time, so gps-time is min === max === 0 — a live
  // potree/potree#909. Task 2's guarded constants keep it finite; recomputing
  // 1/(max-min) would make every value NaN.
  it("keeps a degenerate gps-time finite under a gpu f32 lane", async () => {
    const d = await decodeSlice("brotli.r10", {
      attributes: ["gps-time"],
      scalarFormat: "gpu",
    });
    const gps = d.result.attributesByName.get("gps-time")!;
    expect(gps.array).toBeInstanceOf(Float32Array);
    for (let i = 0; i < d.result.numPoints; i++) {
      expect(Number.isFinite(gps.array[i])).toBe(true);
      expect(Number.isNaN(gps.array[i])).toBe(false);
    }
  });

  it("warns about a multi-element brotli attribute it cannot verify", () => {
    const layout = createPointLayout(fixtureSource("brotli"), {
      attributes: "all",
    });
    // All twelve lion attributes are scalar apart from position and rgb, both
    // special-cased, so nothing should trip the warning on real data.
    expect(layout.warnings.map((w) => w.code)).not.toContain(
      "unverified-brotli-attribute",
    );
  });
});

describe("brotli: decompression cascade", () => {
  it("passes DEFAULT bytes through untouched, zero-copy", async () => {
    const layout = createPointLayout(fixtureSource("autzen"));
    const bytes = loadFixtureOctree("autzen.r604421");
    expect(await decompressNodeBytes(layout, bytes, 100)).toBe(bytes);
  });

  it("uses a caller-supplied decompressor in preference to any tier", async () => {
    const layout = createPointLayout(fixtureSource("brotli"));
    let called = 0;
    const blob = await decompressNodeBytes(
      layout,
      loadFixtureOctree("brotli.r11"),
      3,
      {
        decompress: (input, expected) => {
          called++;
          expect(expected).toBe(3 * 47);
          return new Uint8Array(brotliDecompressSync(input));
        },
      },
    );
    expect(called).toBe(1);
    expect(blob.byteLength).toBe(141);
  });

  it("wraps a decompressor failure as decode-error", async () => {
    const layout = createPointLayout(fixtureSource("brotli"));
    try {
      await decompressNodeBytes(layout, loadFixtureOctree("brotli.r11"), 3, {
        decompress: () => {
          throw new Error("boom");
        },
      });
      throw new Error("expected a decode-error");
    } catch (err) {
      if (!isVoxelkloudError(err)) throw err;
      expect(err.code).toBe("decode-error");
    }
  });

  // Brotli tolerates trailing garbage: a stream with zeros appended still
  // decompresses successfully, so ONLY the length identity catches an over-wide
  // range response.
  it("catches an over-wide response that still decompresses", async () => {
    const source = fixtureSource("brotli");
    const layout = createPointLayout(source);
    const node = nodeFor("brotli.r11");
    const good = new Uint8Array(
      await decompressNodeBytes(layout, loadFixtureOctree("brotli.r11"), 3),
    );
    const padded = new Uint8Array(good.byteLength + 47);
    padded.set(good);
    // Round-trip it so this really is a valid brotli stream, not a hand-forged
    // buffer: the point is that decompression SUCCEEDS and the length check is
    // what fails.
    const recompressed = brotliCompressSync(padded);
    const blob = await decompressNodeBytes(
      layout,
      recompressed.buffer.slice(
        recompressed.byteOffset,
        recompressed.byteOffset + recompressed.byteLength,
      ) as ArrayBuffer,
      3,
    );
    expect(blob.byteLength).toBe(padded.byteLength);
    expect(() =>
      decodePointData(createPointDataRequest(layout, node, blob), source),
    ).toThrow(/expected 141 bytes/);
  });
});
