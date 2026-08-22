import { childBoundingBox } from "@voxelkloud/core";
import type { BoundingBox, ChildIndex } from "@voxelkloud/core";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_BINARY_SIZES,
  fixtureSource,
  loadFixtureHierarchy,
} from "./__fixtures__/index.js";
import {
  buildChunk,
  buildFile,
  setRawHigh,
  toArrayBuffer,
} from "./__fixtures__/chunk-builder.js";
import { isVoxelkloudError } from "./errors.js";
import { createHierarchy } from "./hierarchy.js";
import type { FixtureName } from "./__fixtures__/index.js";
import type { HierarchyNode, PointCloudHierarchy } from "./hierarchy-types.js";

/** A fully expanded tree over the vendored bytes, with zero I/O. */
async function expanded(name: FixtureName): Promise<PointCloudHierarchy> {
  const h = createHierarchy(fixtureSource(name), {
    buffer: loadFixtureHierarchy(name),
  });
  await h.expandAll();
  return h;
}

/** A tree over hand-built bytes; the root chunk is the whole file by default. */
function synthetic(bytes: Uint8Array, firstChunkSize = bytes.byteLength) {
  const source = fixtureSource("synthetic");
  const patched = {
    ...source,
    metadata: {
      ...source.metadata,
      hierarchy: { ...source.metadata.hierarchy, firstChunkSize },
    },
  };
  return createHierarchy(patched, { buffer: toArrayBuffer(bytes) });
}

function expectFatal(fn: () => unknown, contains?: string) {
  try {
    fn();
  } catch (err) {
    if (!isVoxelkloudError(err)) throw err;
    expect(err.code).toBe("hierarchy-error");
    if (contains !== undefined) expect(err.message).toContain(contains);
    return err;
  }
  throw new Error("expected a hierarchy-error");
}

describe("hierarchy: golden invariants over real converter output", () => {
  it.each([
    ["autzen", 4377, 10_653_336, 192],
    ["brotli", 117, 341_989, 1],
    ["synthetic", 9, 17_500, 1],
  ] as const)(
    "%s expands to the measured tree shape",
    async (name, nodes, points, chunks) => {
      const h = await expanded(name);
      expect(h.nodeCount).toBe(nodes);
      expect(h.knownPoints).toBe(points);
      expect(h.stats.chunksParsed).toBe(chunks);
      // The strongest end-to-end check available: the tree accounts for every
      // point the manifest declares, exactly.
      expect(h.knownPoints).toBe(h.source.metadata.points);
      expect(h.warnings.filter((w) => w.code === "point-count-mismatch")).toEqual(
        [],
      );
    },
  );

  it("autzen's non-proxy byte ranges tile octree.bin exactly", async () => {
    const h = await expanded("autzen");
    const ranges: Array<[number, number]> = [];
    for (const n of h.nodes()) {
      if (n.byteSize === undefined || n.byteSize === 0) continue;
      ranges.push([n.byteOffset!, n.byteOffset! + n.byteSize]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    expect(ranges[0]![0]).toBe(0);
    let cursor = 0;
    for (const [start, end] of ranges) {
      expect(start).toBe(cursor); // no gaps, no overlaps
      cursor = end;
    }
    expect(cursor).toBe(FIXTURE_BINARY_SIZES.autzen.octree);
  });

  it("resolves every proxy: no node is left unexpanded", async () => {
    const h = await expanded("autzen");
    const unexpanded = [...h.nodes()].filter((n) => n.state !== "expanded");
    expect(unexpanded).toEqual([]);
    // 192 nodes own a chunk (the root + 191 proxies).
    expect([...h.nodes()].filter((n) => n.chunk !== undefined)).toHaveLength(192);
  });

  it("keeps parent/child links and names consistent", async () => {
    const h = await expanded("autzen");
    for (const n of h.nodes()) {
      if (n.parent === undefined) {
        expect(n.name).toBe("r");
        expect(n.level).toBe(0);
        continue;
      }
      expect(n.parent.children[n.childIndex]).toBe(n);
      expect(n.name).toBe(n.parent.name + String(n.childIndex));
      expect(n.level).toBe(n.parent.level + 1);
      expect(n.name.length - 1).toBe(n.level);
      // Ordering guarantees Tasks 4/6/7 build on.
      expect(n.parent.index).toBeLessThan(n.index);
    }
  });

  it("gives each node's children a contiguous ascending index run", async () => {
    const h = await expanded("autzen");
    for (const n of h.nodes()) {
      const kids = [...n.children].filter((c): c is HierarchyNode => c !== undefined);
      if (kids.length < 2) continue;
      for (let i = 1; i < kids.length; i++) {
        expect(kids[i]!.index).toBe(kids[i - 1]!.index + 1);
      }
    }
  });

  it("matches childMask to the populated child slots", async () => {
    const h = await expanded("autzen");
    for (const n of h.nodes()) {
      let mask = 0;
      for (let c = 0; c < 8; c++) if (n.children[c] !== undefined) mask |= 1 << c;
      expect(n.childMask).toBe(mask);
    }
  });

  // The trap: 660 of autzen's records are typed Leaf(1) with a non-zero
  // childMask. Branching on `type` would drop 4120 of 4377 nodes while
  // completing without error, which is why `type` is never exposed.
  it("does not treat the type byte as a has-children signal", async () => {
    const h = await expanded("autzen");
    const withChildren = [...h.nodes()].filter((n) => (n.childMask ?? 0) !== 0);
    expect(withChildren.length).toBeGreaterThan(600);
    expect(h.nodeCount).toBe(4377);
    // synthetic is the other direction: all records are type 0 (Normal) and 8
    // of 9 have childMask 0.
    const s = await expanded("synthetic");
    expect([...s.nodes()].filter((n) => n.childMask === 0)).toHaveLength(8);
  });

  it("expands the root chunk alone to 257 nodes on autzen", async () => {
    const h = createHierarchy(fixtureSource("autzen"), {
      buffer: loadFixtureHierarchy("autzen"),
    });
    expect(h.tryExpandSync(h.root)).toBe(true);
    expect(h.nodeCount).toBe(257);
    // 0b01010101 — octants 0, 2, 4 and 6, i.e. only the lower-Z half, which
    // is what a terrain scan's root looks like. Verified straight from the
    // bytes, not assumed.
    expect(h.root.childMask).toBe(85);
    // One request's worth of hierarchy already budgets a quarter of the cloud.
    expect(h.knownPoints).toBe(2_719_730);
  });

  it("normalises the root's unknown fields before its chunk arrives", () => {
    const h = createHierarchy(fixtureSource("autzen"));
    expect(h.root.state).toBe("unexpanded");
    expect(h.root.numPoints).toBe(0);
    expect(h.root.childMask).toBeUndefined();
    expect(h.root.byteOffset).toBeUndefined();
    expect(h.root.chunk).toEqual({ byteOffset: 0, byteSize: 5654 });
  });

  it("freezes a node exactly when it becomes expanded", async () => {
    const h = createHierarchy(fixtureSource("autzen"), {
      buffer: loadFixtureHierarchy("autzen"),
    });
    expect(Object.isFrozen(h.root)).toBe(false);
    expect(h.root.state).toBe("unexpanded");
    h.tryExpandSync(h.root);
    expect(Object.isFrozen(h.root)).toBe(true);
    await h.expandAll();
    for (const n of h.nodes()) {
      expect(Object.isFrozen(n)).toBe(n.state === "expanded");
      expect(Object.isFrozen(n)).toBe(true);
    }
  });

  it("shares one frozen tuple across every childless node", async () => {
    const h = await expanded("autzen");
    const childless = [...h.nodes()].filter((n) => n.childMask === 0);
    expect(childless.length).toBe(3525);
    const first = childless[0]!.children;
    for (const n of childless) expect(n.children).toBe(first);
  });

  it("resolves names by walking child slots", async () => {
    const h = await expanded("autzen");
    for (const n of h.nodes()) expect(h.nodeByName(n.name)).toBe(n);
    expect(h.nodeByName("r9")).toBeUndefined(); // 9 is not an octant
    expect(h.nodeByName("x0")).toBeUndefined();
    expect(h.nodeByName("r00000000")).toBeUndefined();
  });

  it("derives the per-level radius exactly from the root box", async () => {
    const h = await expanded("autzen");
    for (const n of h.nodes()) {
      const half =
        0.5 * Math.hypot(n.maxX - n.minX, n.maxY - n.minY, n.maxZ - n.minZ);
      expect(h.radiusAt(n.level)).toBeCloseTo(half, 9);
    }
  });

  it("keeps node boxes in absolute CRS units", async () => {
    const h = await expanded("autzen");
    const box = h.source.metadata.boundingBox;
    expect(h.boundingBoxOf(h.root)).toEqual({ min: box.min, max: box.max });
    for (const n of h.nodes()) {
      expect(n.minX).toBeGreaterThanOrEqual(box.min[0] - 1e-6);
      expect(n.maxX).toBeLessThanOrEqual(box.max[0] + 1e-6);
    }
  });

  // The fused halving in makeChildNode must be bit-identical to core's
  // childBoundingBox, not merely close.
  it("halves boxes bit-identically to core's childBoundingBox", async () => {
    const h = await expanded("autzen");
    for (const n of h.nodes()) {
      if (n.parent === undefined) continue;
      const parentBox: BoundingBox = {
        min: [n.parent.minX, n.parent.minY, n.parent.minZ],
        max: [n.parent.maxX, n.parent.maxY, n.parent.maxZ],
      };
      const expectedBox = childBoundingBox(parentBox, n.childIndex);
      expect(n.minX).toBe(expectedBox.min[0]);
      expect(n.minY).toBe(expectedBox.min[1]);
      expect(n.minZ).toBe(expectedBox.min[2]);
      expect(n.maxX).toBe(expectedBox.max[0]);
      expect(n.maxY).toBe(expectedBox.max[1]);
      expect(n.maxZ).toBe(expectedBox.max[2]);
    }
  });

  it("halves boxes identically for random boxes across all 8 octants", () => {
    const source = fixtureSource("synthetic");
    for (let t = 0; t < 200; t++) {
      const min: [number, number, number] = [
        (t * 37) % 1000 - 500 + 0.137,
        (t * 91) % 733 - 300 + 0.911,
        (t * 13) % 211 - 100 + 0.523,
      ];
      const max: [number, number, number] = [
        min[0] + 1 + (t % 97) * 1.31,
        min[1] + 1 + (t % 53) * 2.17,
        min[2] + 1 + (t % 29) * 0.73,
      ];
      const patched = {
        ...source,
        metadata: { ...source.metadata, boundingBox: { min, max } },
      };
      for (let c = 0 as ChildIndex; c < 8; c = (c + 1) as ChildIndex) {
        const bytes = buildChunk([
          { childMask: 1 << c },
          { numPoints: 0, byteSize: 0 },
        ]);
        const h = createHierarchy(patched, { buffer: toArrayBuffer(bytes) });
        const patched2 = h as PointCloudHierarchy;
        void patched2;
        const tree = createHierarchy(
          {
            ...patched,
            metadata: {
              ...patched.metadata,
              hierarchy: {
                ...patched.metadata.hierarchy,
                firstChunkSize: bytes.byteLength,
              },
            },
          },
          { buffer: toArrayBuffer(bytes) },
        );
        tree.tryExpandSync(tree.root);
        const child = tree.root.children[c]!;
        const want = childBoundingBox({ min, max }, c);
        expect([child.minX, child.minY, child.minZ]).toEqual(want.min);
        expect([child.maxX, child.maxY, child.maxZ]).toEqual(want.max);
      }
    }
  });
});

describe("hierarchy: warnings on real and synthetic data", () => {
  it("is silent on all three clean fixtures", async () => {
    for (const name of ["autzen", "brotli", "synthetic"] as const) {
      const h = await expanded(name);
      expect(h.warnings).toEqual([]);
    }
  });

  // brotli byteSize is a COMPRESSED length: 0 of 117 records satisfy
  // numPoints * bytesPerPoint === byteSize, which is why the check is gated.
  it("does not fire stride-mismatch on a BROTLI source", async () => {
    const h = await expanded("brotli");
    expect(h.source.isBrotli).toBe(true);
    const satisfying = [...h.nodes()].filter(
      (n) => n.numPoints * h.source.bytesPerPoint === n.byteSize,
    );
    expect(satisfying.length).toBeLessThan(2); // only the 0-point/0-byte case
    expect(h.warnings.map((w) => w.code)).not.toContain("stride-mismatch");
  });

  it("warns on a stride mismatch for an uncompressed source", () => {
    // synthetic is 18 bytes/point; declare 10 points in 100 bytes.
    const bytes = buildChunk([{ numPoints: 10, byteSize: 100 }]);
    const h = synthetic(bytes);
    h.tryExpandSync(h.root);
    expect(h.warnings.map((w) => w.code)).toContain("stride-mismatch");
  });

  // potree/potree#1125 — unreachable from any real fixture, so it can only be
  // built by hand.
  it("forces numPoints to 0 when byteSize is 0, and warns", () => {
    const bytes = buildChunk([{ numPoints: 999, byteSize: 0 }]);
    const h = synthetic(bytes);
    h.tryExpandSync(h.root);
    expect(h.root.numPoints).toBe(0);
    expect(h.warnings.map((w) => w.code)).toContain("zero-byte-node");
  });

  it("emits each warning code at most once", () => {
    const bytes = buildChunk([
      { childMask: 0b11, numPoints: 5, byteSize: 0 },
      { numPoints: 7, byteSize: 0 },
      { numPoints: 9, byteSize: 0 },
    ]);
    const h = synthetic(bytes);
    h.tryExpandSync(h.root);
    expect(h.warnings.filter((w) => w.code === "zero-byte-node")).toHaveLength(1);
  });

  it("warns when the expanded tree misses the declared point count", async () => {
    const bytes = buildChunk([{ numPoints: 5, byteSize: 90 }]);
    const h = synthetic(bytes);
    await h.expandAll();
    expect(h.warnings.map((w) => w.code)).toContain("point-count-mismatch");
  });
});

describe("hierarchy: fatal rules", () => {
  it("rejects a chunk size that is not a multiple of 22", () => {
    const bytes = new Uint8Array(30);
    const h = synthetic(bytes, 30);
    expectFatal(() => {
      h.tryExpandSync(h.root);
      throw h.root.failure!.error;
    }, "not a positive multiple");
  });

  it("rejects a chunk that runs past the end of the file", () => {
    const bytes = buildChunk([{ childMask: 0 }]);
    const h = synthetic(bytes, 44); // claims 2 records, file has 1
    h.tryExpandSync(h.root);
    expect(h.root.state).toBe("failed");
    expect(h.root.failure!.error.code).toBe("hierarchy-error");
    expect(h.root.failure!.error.message).toContain("outside hierarchy.bin");
  });

  it("rejects a cycle", () => {
    // Root chunk names a proxy that points back at offset 0.
    const bytes = buildFile([
      {
        byteOffset: 0,
        records: [
          { childMask: 0b1 },
          { type: 2, byteOffset: 0, byteSize: 44 },
        ],
      },
    ]);
    const h = synthetic(bytes, 44);
    h.tryExpandSync(h.root);
    const proxy = h.root.children[0]!;
    expect(proxy.state).toBe("unexpanded");
    h.tryExpandSync(proxy);
    expect(proxy.state).toBe("failed");
    expect(proxy.failure!.error.message).toContain("cycle");
  });

  it("rejects a proxy as record 0 of a chunk", () => {
    const bytes = buildChunk([{ type: 2, byteOffset: 0, byteSize: 22 }]);
    const h = synthetic(bytes);
    h.tryExpandSync(h.root);
    expect(h.root.state).toBe("failed");
    expect(h.root.failure!.error.message).toContain("it is a proxy");
  });

  it("rejects BFS starvation (more records than the masks name)", () => {
    // Two records, but record 0 has childMask 0 — nothing names record 1.
    const bytes = buildChunk([{ childMask: 0 }, { childMask: 0 }]);
    const h = synthetic(bytes);
    h.tryExpandSync(h.root);
    expect(h.root.state).toBe("failed");
    expect(h.root.failure!.error.message).toContain("ran out of parents");
  });

  it("rejects child masks that overshoot the record count", () => {
    // Record 0 claims 3 children but the chunk holds only 2 records.
    const bytes = buildChunk([{ childMask: 0b111 }, { childMask: 0 }]);
    const h = synthetic(bytes);
    h.tryExpandSync(h.root);
    expect(h.root.state).toBe("failed");
    expect(h.root.failure!.error.message).toContain("more than the");
  });

  it("rejects a proxy whose chunk size is not a positive multiple of 22", () => {
    const bytes = buildChunk([
      { childMask: 0b1 },
      { type: 2, byteOffset: 44, byteSize: 21 },
    ]);
    const h = synthetic(bytes, 44);
    h.tryExpandSync(h.root);
    expect(h.root.state).toBe("failed");
    expect(h.root.failure!.error.message).toContain("proxy chunk size");
  });

  it("rejects an i64 with its sign bit set", () => {
    const bytes = buildChunk([{ byteOffset: 0, byteSize: 0 }]);
    setRawHigh(bytes, 0, "byteOffset", 0x80000000);
    const h = synthetic(bytes);
    h.tryExpandSync(h.root);
    expect(h.root.state).toBe("failed");
    expect(h.root.failure!.error.message).toContain("sign bit");
  });

  it("rejects an i64 at or beyond 2^53", () => {
    const bytes = buildChunk([{ byteOffset: 0, byteSize: 0 }]);
    setRawHigh(bytes, 0, "byteSize", 0x200000);
    const h = synthetic(bytes);
    h.tryExpandSync(h.root);
    expect(h.root.state).toBe("failed");
    expect(h.root.failure!.error.message).toContain("2^53");
  });

  it("enforces maxDepth", () => {
    // A chain deeper than the cap.
    const records = [];
    for (let i = 0; i < 6; i++) records.push({ childMask: 0b1 });
    records.push({ childMask: 0 });
    const source = fixtureSource("synthetic");
    const bytes = buildChunk(records);
    const h = createHierarchy(
      {
        ...source,
        metadata: {
          ...source.metadata,
          hierarchy: {
            ...source.metadata.hierarchy,
            firstChunkSize: bytes.byteLength,
          },
        },
      },
      { buffer: toArrayBuffer(bytes), maxDepth: 3 },
    );
    h.tryExpandSync(h.root);
    expect(h.root.state).toBe("failed");
    expect(h.root.failure!.error.message).toContain("maxDepth");
  });

  it("enforces maxNodes", () => {
    const source = fixtureSource("autzen");
    const h = createHierarchy(source, {
      buffer: loadFixtureHierarchy("autzen"),
      maxNodes: 10,
    });
    h.tryExpandSync(h.root);
    expect(h.root.state).toBe("failed");
    expect(h.root.failure!.error.message).toContain("maxNodes");
  });

  it("leaves the seed untouched when a chunk is malformed (atomicity)", () => {
    const bytes = buildChunk([{ childMask: 0b111 }, { childMask: 0 }]);
    const h = synthetic(bytes);
    const before = h.nodeCount;
    h.tryExpandSync(h.root);
    // Phases A and B never touch the live tree, so nothing was spliced.
    expect(h.nodeCount).toBe(before);
    expect(h.root.children.every((c) => c === undefined)).toBe(true);
    expect(h.root.childMask).toBeUndefined();
    expect(h.root.byteOffset).toBeUndefined();
  });

  it("never throws out of tryExpandSync", () => {
    const bytes = buildChunk([{ type: 2, byteOffset: 0, byteSize: 22 }]);
    const h = synthetic(bytes);
    expect(() => h.tryExpandSync(h.root)).not.toThrow();
    expect(h.tryExpandSync(h.root)).toBe(false);
  });
});

// The count invariants (tail === n) are NOT an ordering proof: a chunk
// permuted into DFS preorder parses to completion and silently assigns wrong
// byte offsets. This pins the known limitation so nobody mistakes the checks
// for conformance validation.
describe("hierarchy: known limitation", () => {
  it("cannot detect a chunk permuted out of BFS order", () => {
    // BFS: root(mask=0b11), childA(mask=0b1), childB(leaf), grandchild(leaf)
    const bfs = buildChunk([
      { childMask: 0b11, byteOffset: 0, byteSize: 0 },
      { childMask: 0b1, byteOffset: 10, byteSize: 0 },
      { childMask: 0, byteOffset: 20, byteSize: 0 },
      { childMask: 0, byteOffset: 30, byteSize: 0 },
    ]);
    const a = synthetic(bfs);
    a.tryExpandSync(a.root);
    expect(a.nodeCount).toBe(4);

    // Same records, records 2 and 3 swapped — still parses, offsets now wrong.
    const permuted = buildChunk([
      { childMask: 0b11, byteOffset: 0, byteSize: 0 },
      { childMask: 0b1, byteOffset: 10, byteSize: 0 },
      { childMask: 0, byteOffset: 30, byteSize: 0 },
      { childMask: 0, byteOffset: 20, byteSize: 0 },
    ]);
    const b = synthetic(permuted);
    b.tryExpandSync(b.root);
    expect(b.nodeCount).toBe(4);
    expect(b.root.state).toBe("expanded"); // no error is raised
    expect(b.nodeByName("r1")!.byteOffset).not.toBe(
      a.nodeByName("r1")!.byteOffset,
    );
  });
});
