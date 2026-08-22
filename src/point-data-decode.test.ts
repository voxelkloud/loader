import { describe, expect, it } from "vitest";
import {
  FIXTURE_NODES,
  fixtureSource,
  loadFixtureHierarchy,
  loadFixtureOctree,
} from "./__fixtures__/index.js";
import { createHierarchy } from "./hierarchy.js";
import { isVoxelkloudError } from "./errors.js";
import { createPointDataRequest, decodePointData } from "./point-data-decode.js";
import { createPointLayout } from "./point-data-layout.js";
import type { PointDataOptions, PointNodeRef } from "./point-data-types.js";
import type { FixtureName, OctreeSliceName } from "./__fixtures__/index.js";

/**
 * Build the real `PointNodeRef` for a vendored slice by expanding the real
 * hierarchy — so the box the containment test uses is the one Task 3 derives,
 * not one hand-copied into the test.
 */
function nodeFor(slice: OctreeSliceName): PointNodeRef {
  const meta = FIXTURE_NODES[slice];
  const source = fixtureSource(meta.fixture);
  const h = createHierarchy(source, {
    buffer: loadFixtureHierarchy(meta.fixture),
  });
  h.tryExpandSync(h.root);
  // Walk down to the node, expanding as needed.
  let node = h.root;
  for (let i = 1; i < meta.name.length; i++) {
    h.tryExpandSync(node);
    const child = node.children[meta.name.charCodeAt(i) - 48];
    if (child === undefined) break;
    node = child;
  }
  h.tryExpandSync(node);
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

function decode(
  slice: OctreeSliceName,
  bytes: ArrayBuffer,
  options: PointDataOptions = {},
) {
  const meta = FIXTURE_NODES[slice];
  const source = fixtureSource(meta.fixture as FixtureName);
  const layout = createPointLayout(source, options);
  const node = nodeFor(slice);
  return {
    source,
    layout,
    node,
    result: decodePointData(
      createPointDataRequest(layout, node, bytes),
      source,
    ),
  };
}

/**
 * The canonical layout check: every decoded position must land inside its node
 * box EXPANDED BY ONE QUANTUM.
 *
 * One quantum is exactly the right tolerance. It is loose enough to be true —
 * 3.80% of real brotli points sit up to 0.94 quanta outside their derived box,
 * a converter property, not a decode error — and tight enough to have teeth:
 * corrupting the layout (AoS instead of SoA, swapped morton word pairs, rotated
 * axis order, an off-by-4 block base, the other child-bit convention) drops the
 * pass rate to between 0% and 36%.
 */
function assertContained(
  result: ReturnType<typeof decode>,
  { minRate = 1 }: { minRate?: number } = {},
) {
  const { result: r, node, layout } = result;
  const { origin } = r.frame;
  const q = layout.quantScale;
  let inside = 0;
  const lo = [node.minX, node.minY, node.minZ];
  const hi = [node.maxX, node.maxY, node.maxZ];
  for (let i = 0; i < r.numPoints; i++) {
    let ok = true;
    for (let k = 0; k < 3; k++) {
      const abs = origin[k]! + r.positions[3 * i + k]! * r.frame.scale[k]!;
      const slack = Math.abs(q[k]!) + r.frame.maxPositionError;
      if (abs < lo[k]! - slack || abs > hi[k]! + slack) ok = false;
    }
    if (ok) inside++;
  }
  expect(inside / r.numPoints).toBeGreaterThanOrEqual(minRate);
  return inside / r.numPoints;
}

describe("decode: DEFAULT path over real converter output", () => {
  it("decodes autzen r604421 with every position contained", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"));
    expect(d.layout.stride).toBe(35);
    expect(d.result.numPoints).toBe(100);
    expect(d.result.positions).toBeInstanceOf(Float32Array);
    expect(d.result.positions.length).toBe(300);
    // DEFAULT is exactly contained: measured overshoot of zero.
    expect(assertContained(d)).toBe(1);
  });

  it("decodes synthetic with every position contained", () => {
    const d = decode(
      "synthetic.first256",
      loadFixtureOctree("synthetic.first256"),
    );
    expect(d.layout.stride).toBe(18);
    expect(d.result.numPoints).toBe(256);
    expect(assertContained(d)).toBe(1);
  });

  it("selects position and colour by default, and nothing else", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"));
    expect(d.result.colors).toBeDefined();
    expect(d.result.attributes).toEqual([]);
    // 12 B position + 4 B rgba, against the reference's 69 B/pt.
    expect(d.layout.bytesPerPointOut).toBe(16);
  });

  it("decodes every attribute under \"all\"", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"), {
      attributes: "all",
    });
    const names = d.result.attributes.map((a) => a.name);
    expect(names).toEqual([
      "intensity",
      "return number",
      "number of returns",
      "classification",
      "scan angle rank",
      "user data",
      "point source id",
      "gps-time",
    ]);
    // Names are verbatim: spaces and the hyphen survive.
    expect(d.result.attributesByName.get("gps-time")!.array).toBeInstanceOf(
      Float64Array,
    );
    expect(d.result.attributesByName.get("intensity")!.array).toBeInstanceOf(
      Uint16Array,
    );
  });

  it("keeps gps-time in float64 and inside its declared range", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"), {
      attributes: ["gps-time"],
    });
    const gps = d.result.attributesByName.get("gps-time")!;
    const src = d.source.attributesByName.get("gps-time")!;
    for (let i = 0; i < d.result.numPoints; i++) {
      expect(gps.array[i]).toBeGreaterThanOrEqual(src.min[0]!);
      expect(gps.array[i]).toBeLessThanOrEqual(src.max[0]!);
    }
  });

  // autzen ships "scan angle rank" as uint8 with min -21; its raw bytes really
  // are two's complement, so the signed GPU lane is the correct one.
  it("puts a negative-min unsigned attribute on the signed lane", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"), {
      attributes: ["scan angle rank"],
      scalarFormat: "gpu",
    });
    const a = d.result.attributesByName.get("scan angle rank")!;
    expect(a.array).toBeInstanceOf(Int32Array);
    expect(a.gpuFormat).toBe("sint32");
  });
});

describe("decode: the coordinate frame", () => {
  it("emits float32 relative to the cloud origin by default", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"));
    expect(d.result.frame.format).toBe("float32");
    expect(d.result.frame.originPolicy).toBe("cloud");
    expect(d.result.frame.origin).toEqual(d.source.metadata.boundingBox.min);
    expect(d.result.frame.scale).toEqual([1, 1, 1]);
  });

  // Absolute float32 loses 0.030 m on autzen — THREE TIMES the file's own
  // 0.01 m quantum, because X and Y live in the binade [2^19, 2^20) where the
  // float32 ULP is 0.0625 m. Relative to the cloud origin the error collapses.
  it("beats absolute float32 by more than two orders of magnitude", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"));
    const exact = decode(
      "autzen.r604421",
      loadFixtureOctree("autzen.r604421"),
      { positionFormat: "int32" },
    );
    const { origin, scale } = d.result.frame;
    const q = d.layout.quantScale;
    const off = d.layout.quantOffset;

    let relErr = 0;
    let absErr = 0;
    for (let i = 0; i < d.result.numPoints; i++) {
      for (let k = 0; k < 3; k++) {
        const truth = exact.result.positions[3 * i + k]! * q[k]! + off[k]!;
        const rel = origin[k]! + d.result.positions[3 * i + k]! * scale[k]!;
        relErr = Math.max(relErr, Math.abs(rel - truth));
        absErr = Math.max(absErr, Math.abs(Math.fround(truth) - truth));
      }
    }
    expect(relErr).toBeLessThan(1e-3);
    expect(absErr).toBeGreaterThan(1e-2);
    expect(absErr / relErr).toBeGreaterThan(100);
    // maxPositionError is an a-priori bound, so it must actually bound.
    expect(relErr).toBeLessThanOrEqual(d.result.frame.maxPositionError);
  });

  it("int32 is exactly lossless and forces the file origin", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"), {
      positionFormat: "int32",
    });
    expect(d.result.positions).toBeInstanceOf(Int32Array);
    expect(d.result.frame.originPolicy).toBe("file");
    expect(d.result.frame.origin).toEqual(d.source.metadata.offset);
    expect(d.result.frame.scale).toEqual(d.source.metadata.scale);
    expect(d.result.frame.maxPositionError).toBe(0);
    expect(assertContained(d)).toBe(1);
  });

  it("origin: node re-bases per node and stays contained", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"), {
      origin: "node",
    });
    expect(d.result.frame.originPolicy).toBe("node");
    expect(d.result.frame.origin).toEqual([d.node.minX, d.node.minY, d.node.minZ]);
    expect(assertContained(d)).toBe(1);
  });

  it("computeBounds reports the decoded extent in absolute CRS", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"), {
      computeBounds: true,
    });
    const b = d.result.bounds!;
    expect(b.min[0]).toBeGreaterThan(600_000);
    for (let k = 0; k < 3; k++) {
      expect(b.min[k]!).toBeLessThanOrEqual(b.max[k]!);
    }
    expect(
      decode("autzen.r604421", loadFixtureOctree("autzen.r604421")).result.bounds,
    ).toBeUndefined();
  });
});

describe("decode: colour", () => {
  // The reference's per-value `c > 255 ? c/256 : c` destroys the hue of any
  // point whose channel lands at or below 255 while another exceeds it. On
  // demo/data/synthetic that is 213 of 17,500 points.
  it("narrows 16-bit colour by a per-source shift, not a per-value guess", () => {
    const d = decode(
      "synthetic.first256",
      loadFixtureOctree("synthetic.first256"),
    );
    const c = d.result.colors!;
    expect(c.declaredMax).toBe(65535);
    expect(c.shift).toBe(8);
    expect(c.array).toBeInstanceOf(Uint8Array);

    // Point 54 is raw (176, 17286, 8791). The correct narrowing is
    // (0, 67, 34) — dark green. The reference renders (176, 67, 34), orange.
    const native = decode(
      "synthetic.first256",
      loadFixtureOctree("synthetic.first256"),
      { colorFormat: "native" },
    ).result.colors!;
    const raw = [
      native.array[54 * 4]!,
      native.array[54 * 4 + 1]!,
      native.array[54 * 4 + 2]!,
    ];
    expect(raw[0]).toBeLessThanOrEqual(255);
    expect(raw[1]).toBeGreaterThan(255);
    expect(c.array[54 * 4]).toBe(raw[0]! >>> 8);
    expect(c.array[54 * 4]).not.toBe(raw[0]);
  });

  it("does not shift autzen, whose uint16 rgb declares max 255", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"));
    const c = d.result.colors!;
    expect(c.declaredMax).toBe(255);
    expect(c.shift).toBe(0);
    // Lossless: every channel already fits in 8 bits.
    for (let i = 0; i < d.result.numPoints * 4; i++) {
      expect(c.array[i]).toBeLessThanOrEqual(255);
    }
  });

  it("always writes alpha", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"));
    const c = d.result.colors!;
    for (let i = 0; i < d.result.numPoints; i++) {
      // The reference leaves alpha 0 for every point and gets away with it only
      // because its shader binds a vec3.
      expect(c.array[4 * i + 3]).toBe(c.maxValue);
    }
  });

  it("native colour keeps 16 bits", () => {
    const d = decode(
      "synthetic.first256",
      loadFixtureOctree("synthetic.first256"),
      { colorFormat: "native" },
    );
    expect(d.result.colors!.array).toBeInstanceOf(Uint16Array);
    expect(d.result.colors!.gpuFormat).toBe("uint16x4");
    expect(d.result.colors!.shift).toBe(0);
  });
});

describe("decode: output contract", () => {
  it("never aliases the input buffer", () => {
    const bytes = loadFixtureOctree("autzen.r604421");
    const d = decode("autzen.r604421", bytes, { attributes: "all" });
    for (const b of d.result.transferList) expect(b).not.toBe(bytes);
    expect(d.result.positions.buffer).not.toBe(bytes);
  });

  it("lists every output buffer exactly once", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"), {
      attributes: "all",
    });
    const list = d.result.transferList;
    expect(new Set(list).size).toBe(list.length);
    // positions + colours + 8 scalars
    expect(list.length).toBe(10);
    let total = 0;
    for (const b of list) total += b.byteLength;
    expect(d.result.byteLength).toBe(total);
  });

  it("survives a structured clone (worker readiness)", () => {
    const d = decode("autzen.r604421", loadFixtureOctree("autzen.r604421"), {
      attributes: "all",
    });
    const clone = structuredClone(d.result);
    expect(clone.numPoints).toBe(d.result.numPoints);
    expect(clone.positions[0]).toBe(d.result.positions[0]);
    expect(clone.frame.origin).toEqual(d.result.frame.origin);
  });

  it("has a structured-cloneable layout too", () => {
    const layout = createPointLayout(fixtureSource("autzen"), {
      attributes: "all",
    });
    const clone = structuredClone(layout);
    expect(clone.stride).toBe(35);
    expect(clone.fields.length).toBe(layout.fields.length);
  });
});

describe("decode: fatal", () => {
  // The check the reference does not have. Without it, a host that ignores
  // Range hands back the whole file and the decoder reads numPoints records
  // from byte 0 of the FILE rather than of the node.
  it("rejects a buffer whose length is not numPoints * stride", () => {
    const bytes = loadFixtureOctree("autzen.r604421");
    const short = bytes.slice(0, bytes.byteLength - 35);
    const source = fixtureSource("autzen");
    const layout = createPointLayout(source);
    const node = nodeFor("autzen.r604421");
    try {
      decodePointData(createPointDataRequest(layout, node, short), source);
      throw new Error("expected a decode-error");
    } catch (err) {
      if (!isVoxelkloudError(err)) throw err;
      expect(err.code).toBe("decode-error");
      expect(err.message).toContain("3500");
    }
  });

  it("rejects an over-long buffer just as firmly", () => {
    const bytes = loadFixtureOctree("autzen.r604421");
    const long = new Uint8Array(bytes.byteLength + 35);
    long.set(new Uint8Array(bytes));
    const source = fixtureSource("autzen");
    const layout = createPointLayout(source);
    const node = nodeFor("autzen.r604421");
    expect(() =>
      decodePointData(
        createPointDataRequest(layout, node, long.buffer as ArrayBuffer),
        source,
      ),
    ).toThrow(/expected 3500 bytes/);
  });
});
