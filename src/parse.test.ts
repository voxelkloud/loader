import { describe, expect, it } from "vitest";
import {
  FAKE_URLS,
  FIXTURE_BINARY_SIZES,
  loadFixtureJson,
  mutate,
} from "./__fixtures__/index.js";
import { isVoxelkloudError } from "./errors.js";
import { parsePointCloudSource } from "./parse.js";
import type { PointCloudWarningCode } from "./types.js";

const parse = (json: unknown) => parsePointCloudSource(json, FAKE_URLS);

/** Assert a throw, returning the narrowed error. */
function expectThrows(fn: () => unknown, code: string, path?: string) {
  try {
    fn();
  } catch (err) {
    if (!isVoxelkloudError(err)) throw err;
    expect(err.code).toBe(code);
    if (path !== undefined) expect(err.path).toBe(path);
    return err;
  }
  throw new Error(`expected a ${code} error`);
}

const codes = (w: readonly { code: PointCloudWarningCode }[]) =>
  w.map((x) => x.code);

describe("parse: golden path", () => {
  it("derives the autzen record layout", () => {
    const s = parse(loadFixtureJson("autzen"));
    expect(s.bytesPerPoint).toBe(35);
    expect(s.attributes).toHaveLength(10);
    expect(s.attributes.map((a) => a.byteOffset)).toEqual([
      0, 12, 14, 15, 16, 17, 18, 19, 21, 29,
    ]);
    expect(s.attributes.map((a) => a.name)).toEqual([
      "position",
      "intensity",
      "return number",
      "number of returns",
      "classification",
      "scan angle rank",
      "user data",
      "point source id",
      "gps-time",
      "rgb",
    ]);
    expect(s.warnings).toEqual([]);
  });

  it("derives the synthetic record layout with no warnings", () => {
    const s = parse(loadFixtureJson("synthetic"));
    expect(s.bytesPerPoint).toBe(18);
    expect(s.attributes.map((a) => a.byteOffset)).toEqual([0, 12]);
    // A manifest that legitimately omits scale/offset/histogram must be silent.
    expect(s.warnings).toEqual([]);
  });

  // The highest-value test in the suite: the derived stride, multiplied by the
  // declared point count, must equal the real octree.bin length byte-for-byte.
  it("reproduces both octree.bin lengths exactly (stride invariant)", () => {
    const autzen = parse(loadFixtureJson("autzen"));
    expect(autzen.bytesPerPoint * autzen.metadata.points).toBe(
      FIXTURE_BINARY_SIZES.autzen.octree,
    );
    const synthetic = parse(loadFixtureJson("synthetic"));
    expect(synthetic.bytesPerPoint * synthetic.metadata.points).toBe(
      FIXTURE_BINARY_SIZES.synthetic.octree,
    );
  });

  it("round-trips the metadata scalars exactly", () => {
    const { metadata: m } = parse(loadFixtureJson("autzen"));
    expect(m.version).toBe("2.0");
    expect(m.name).toBe("autzen");
    expect(m.description).toBe("");
    expect(m.points).toBe(10_653_336);
    expect(m.projection).toBe("");
    expect(m.encoding).toBe("DEFAULT");
    expect(m.spacing).toBe(36.371171875000073);
    expect(m.scale).toEqual([0.01, 0.01, 0.01]);
    expect(m.offset).toEqual([635577.79, 848882.15, 406.14]);
    expect(m.hierarchy.firstChunkSize).toBe(5654);
    expect(m.hierarchy.stepSize).toBe(4);
    expect(m.hierarchy.depth).toBe(7);
  });

  it("exposes the tight bounds, not the cube", () => {
    const s = parse(loadFixtureJson("autzen"));
    expect(s.tightBoundingBox.min).toEqual([635577.79, 848882.15, 406.14]);
    expect(s.tightBoundingBox.max).toEqual([639003.73, 853537.66, 615.26]);
    // The cube overshoots Z by ~22x — this is exactly what potree gets wrong.
    const tightZ =
      s.tightBoundingBox.max[2] - s.tightBoundingBox.min[2];
    const cubeZ =
      s.metadata.boundingBox.max[2] - s.metadata.boundingBox.min[2];
    expect(tightZ).toBeCloseTo(209.12, 6);
    expect(cubeZ).toBeCloseTo(4655.51, 6);
  });

  it("treats the cubic bounding box as cubic (no warning)", () => {
    const s = parse(loadFixtureJson("autzen"));
    const { min, max } = s.metadata.boundingBox;
    const extents = [0, 1, 2].map((i) => max[i]! - min[i]!);
    expect(extents[0]).toBe(extents[1]);
    expect(extents[1]).toBe(extents[2]);
    expect(codes(s.warnings)).not.toContain("non-cubic-bounding-box");
  });

  it("preserves the classification histogram", () => {
    const s = parse(loadFixtureJson("autzen"));
    const cls = s.attributesByName.get("classification")!;
    expect(cls.histogram).toHaveLength(256);
    expect(cls.histogram!.reduce((a, b) => a + b, 0)).toBe(10_653_336);
    expect(cls.histogram![1]).toBe(7_918_771);
    expect(cls.histogram![2]).toBe(2_734_565);
  });

  it("keeps rgb named rgb and tags it with the color role", () => {
    const s = parse(loadFixtureJson("autzen"));
    const rgb = s.attributesByName.get("rgb")!;
    expect(rgb.name).toBe("rgb");
    expect(s.attributesByName.has("rgba")).toBe(false);
    expect(rgb.role).toBe("color");
    expect(rgb.numElements).toBe(3);
    expect(rgb.type).toBe("uint16");
    expect(rgb.byteSize).toBe(6);
  });

  it("assigns the position and color roles in the synthetic fixture", () => {
    const s = parse(loadFixtureJson("synthetic"));
    expect(s.attributes[0]!.role).toBe("position");
    expect(s.attributes[1]!.role).toBe("color");
    expect(codes(s.warnings)).not.toContain("missing-position-attribute");
  });

  it("accepts POSITION_CARTESIAN as a position alias", () => {
    const s = parse(
      mutate("synthetic", (m) => {
        (m["attributes"] as Record<string, unknown>[])[0]!["name"] =
          "POSITION_CARTESIAN";
      }),
    );
    expect(s.attributes[0]!.role).toBe("position");
    expect(codes(s.warnings)).not.toContain("missing-position-attribute");
  });

  it("defaults absent per-attribute scale/offset to identity, silently", () => {
    const s = parse(loadFixtureJson("synthetic"));
    expect(s.attributes[0]!.scale).toEqual([1, 1, 1]);
    expect(s.attributes[0]!.offset).toEqual([0, 0, 0]);
    expect(s.attributes[1]!.scale).toEqual([1, 1, 1]);
    expect(codes(s.warnings)).not.toContain("non-identity-attribute-transform");
  });

  it("preserves present per-attribute scale/offset verbatim", () => {
    const s = parse(loadFixtureJson("autzen"));
    for (const a of s.attributes) {
      expect(a.scale).toHaveLength(a.numElements);
      expect(a.offset).toHaveLength(a.numElements);
      expect(a.scale.every((v) => v === 1)).toBe(true);
      expect(a.offset.every((v) => v === 0)).toBe(true);
    }
    expect(codes(s.warnings)).not.toContain("non-identity-attribute-transform");
  });

  it("derives normalization only for wide scalars", () => {
    const s = parse(loadFixtureJson("autzen"));
    const gps = s.attributesByName.get("gps-time")!;
    expect(gps.normalization).toEqual({
      offset: 245369.89656867139,
      scale: 1 / (249783.70297086134 - 245369.89656867139),
    });
    // Narrow scalars and vectors need no packing.
    expect(s.attributesByName.get("intensity")!.normalization).toBeUndefined();
    expect(s.attributesByName.get("position")!.normalization).toBeUndefined();
    expect(s.attributesByName.get("rgb")!.normalization).toBeUndefined();
  });

  // The rule the reference gets wrong: min/max are semantic, in the
  // attribute's own domain, and are NOT constrained by the storage type.
  it("never validates min/max against the storage type", () => {
    const s = parse(loadFixtureJson("autzen"));
    const rank = s.attributesByName.get("scan angle rank")!;
    expect(rank.type).toBe("uint8");
    expect(rank.min).toEqual([-21]); // negative min on an unsigned type
    const position = s.attributesByName.get("position")!;
    expect(position.type).toBe("int32");
    expect(Number.isInteger(position.min[0])).toBe(false); // CRS doubles
    expect(s.warnings).toEqual([]);
  });

  it("computes the correct width for all ten type names", () => {
    const types = [
      "int8",
      "uint8",
      "int16",
      "uint16",
      "int32",
      "uint32",
      "int64",
      "uint64",
      "float",
      "double",
    ];
    const s = parse({
      ...loadFixtureJson("synthetic"),
      attributes: types.map((type) => ({
        name: type,
        description: "",
        numElements: 1,
        type,
        min: [0],
        max: [1],
      })),
    });
    expect(s.attributes.map((a) => a.elementSize)).toEqual([
      1, 1, 2, 2, 4, 4, 8, 8, 4, 8,
    ]);
    expect(s.bytesPerPoint).toBe(1 + 1 + 2 + 2 + 4 + 4 + 8 + 8 + 4 + 8); // 42
  });
});

// Generated with the real PotreeConverter 2.x (--encoding BROTLI) from
// demo/potree/pointclouds/lion_takanawa.copc.laz. It is the only fixture that
// exercises the compressed path, and it is stock converter output, so anything
// it trips is something real users will hit.
describe("parse: BROTLI fixture (real converter output)", () => {
  it("parses cleanly and sets isBrotli", () => {
    const s = parse(loadFixtureJson("brotli"));
    expect(s.metadata.encoding).toBe("BROTLI");
    expect(s.isBrotli).toBe(true);
    expect(s.metadata.points).toBe(341_989);
    expect(s.attributes).toHaveLength(12);
  });

  // The reason bytesPerPoint carries a DEFAULT/UNCOMPRESSED-only caveat: under
  // BROTLI the octree is compressed, so deriving a point count from a byte
  // length is off by 7x here.
  it("has a bytesPerPoint that is NOT the octree.bin stride", () => {
    const s = parse(loadFixtureJson("brotli"));
    expect(s.bytesPerPoint).toBe(41);
    const naive = s.bytesPerPoint * s.metadata.points;
    expect(naive).toBe(14_021_549);
    expect(naive).not.toBe(FIXTURE_BINARY_SIZES.brotli.octree);
    expect(naive / FIXTURE_BINARY_SIZES.brotli.octree).toBeGreaterThan(6);
  });

  it("assigns roles despite converter-specific attribute names", () => {
    const s = parse(loadFixtureJson("brotli"));
    // This dataset carries names autzen does not: "classification flags",
    // "scan angle" (vs autzen's "scan angle rank") and a camelCase "OriginId".
    expect(s.attributesByName.has("classification flags")).toBe(true);
    expect(s.attributesByName.has("OriginId")).toBe(true);
    expect(s.attributesByName.get("position")!.role).toBe("position");
    expect(s.attributesByName.get("rgb")!.role).toBe("color");
  });

  // A live instance of potree/potree#909: lion_takanawa has no GPS time, so
  // gps-time is min===max===0. Without the guard, 1/(max-min) is Infinity and
  // every value decodes to NaN.
  it("guards the degenerate gps-time range on real data", () => {
    const s = parse(loadFixtureJson("brotli"));
    const gps = s.attributesByName.get("gps-time")!;
    expect(gps.min).toEqual([0]);
    expect(gps.max).toEqual([0]);
    expect(gps.normalization).toEqual({ offset: 0, scale: 1 });
    expect(Number.isFinite(gps.normalization!.scale)).toBe(true);
    expect(codes(s.warnings)).toContain("degenerate-range");
  });

  // "classification flags" and "scan angle" are also min===max here, but they
  // are narrow scalars that never get packed into float32, so they must not
  // warn — the guard keys on width, not on a degenerate range alone.
  it("does not warn about degenerate ranges on narrow scalars", () => {
    const s = parse(loadFixtureJson("brotli"));
    const flags = s.attributesByName.get("classification flags")!;
    expect(flags.min).toEqual([0]);
    expect(flags.max).toEqual([0]);
    expect(flags.normalization).toBeUndefined();
    expect(s.warnings.filter((w) => w.code === "degenerate-range")).toHaveLength(
      1,
    );
  });

  // PotreeConverter writes attribute min/max with ~2 decimals while
  // boundingBox keeps full precision, so position.min is literally
  // boundingBox.min rounded: -4.99 vs -4.985. A tight epsilon would fire on
  // stock output for small-coordinate datasets and not for large ones.
  it("does not warn when rounded position bounds graze the box", () => {
    const s = parse(loadFixtureJson("brotli"));
    expect(s.tightBoundingBox.min[0]).toBeLessThan(
      s.metadata.boundingBox.min[0],
    );
    expect(codes(s.warnings)).not.toContain("tight-bounds-outside-bounding-box");
  });

  it("still warns when the bounds escape by a real margin", () => {
    const s = parse(
      mutate("brotli", (m) => {
        const pos = (m["attributes"] as Record<string, unknown>[])[0]!;
        const max = [...(pos["max"] as number[])];
        max[2] = max[2]! + 100; // ~18x the box extent, unambiguously wrong
        pos["max"] = max;
      }),
    );
    expect(codes(s.warnings)).toContain("tight-bounds-outside-bounding-box");
  });
});

describe("parse: warnings", () => {
  it("warns on a degenerate range and guards the denominator", () => {
    const s = parse(
      mutate("autzen", (m) => {
        const attrs = m["attributes"] as Record<string, unknown>[];
        attrs[8]!["max"] = [...(attrs[8]!["min"] as number[])];
      }),
    );
    expect(codes(s.warnings)).toContain("degenerate-range");
    // 1/(0 || 1) === 1, not Infinity — every value decodes to 0, not NaN.
    expect(s.attributesByName.get("gps-time")!.normalization!.scale).toBe(1);
  });

  it("generalises the degenerate-range guard past the name gps-time", () => {
    const s = parse(
      mutate("autzen", (m) => {
        const attrs = m["attributes"] as Record<string, unknown>[];
        attrs[8]!["name"] = "gpsTime";
        attrs[8]!["max"] = [...(attrs[8]!["min"] as number[])];
      }),
    );
    expect(codes(s.warnings)).toContain("degenerate-range");
    expect(s.attributesByName.get("gpsTime")!.normalization!.scale).toBe(1);
  });

  it("warns on an int64 attribute but still parses", () => {
    const s = parse(
      mutate("synthetic", (m) => {
        (m["attributes"] as Record<string, unknown>[])[1] = {
          name: "t",
          description: "",
          size: 8,
          numElements: 1,
          elementSize: 8,
          type: "int64",
          min: [0],
          max: [1],
        };
      }),
    );
    expect(codes(s.warnings)).toContain("undecodable-attribute-type");
    expect(s.bytesPerPoint).toBe(20);
  });

  it.each([
    ["BROTLI", true, false],
    ["UNCOMPRESSED", false, false],
    ["LZ4", false, true],
  ])("handles encoding %s", (encoding, isBrotli, warns) => {
    const s = parse(mutate("synthetic", (m) => (m["encoding"] = encoding)));
    expect(s.metadata.encoding).toBe(encoding);
    expect(s.isBrotli).toBe(isBrotli);
    expect(codes(s.warnings).includes("unknown-encoding")).toBe(warns);
  });

  it("defaults a missing encoding to DEFAULT with no warning", () => {
    const s = parse(mutate("synthetic", (m) => delete m["encoding"]));
    expect(s.metadata.encoding).toBe("DEFAULT");
    expect(s.isBrotli).toBe(false);
    expect(s.warnings).toEqual([]);
  });

  it("warns on an unexpected 2.x version but parses", () => {
    const s = parse(mutate("autzen", (m) => (m["version"] = "2.1")));
    expect(codes(s.warnings)).toContain("unexpected-version");
  });

  it("warns on a missing version and defaults it to empty", () => {
    const s = parse(mutate("autzen", (m) => delete m["version"]));
    expect(s.metadata.version).toBe("");
    expect(codes(s.warnings)).toContain("unexpected-version");
  });

  it("warns on a missing point count and defaults to 0", () => {
    const s = parse(mutate("autzen", (m) => delete m["points"]));
    expect(s.metadata.points).toBe(0);
    expect(codes(s.warnings)).toContain("missing-point-count");
  });

  it("warns on a declared size mismatch and keeps the canonical width", () => {
    const s = parse(
      mutate("autzen", (m) => {
        (m["attributes"] as Record<string, unknown>[])[0]!["size"] = 13;
      }),
    );
    expect(s.bytesPerPoint).toBe(35);
    expect(s.attributes.map((a) => a.byteOffset)).toEqual([
      0, 12, 14, 15, 16, 17, 18, 19, 21, 29,
    ]);
    expect(codes(s.warnings)).toContain("declared-size-mismatch");
  });

  it("warns on a declared elementSize mismatch", () => {
    const s = parse(
      mutate("autzen", (m) => {
        (m["attributes"] as Record<string, unknown>[])[1]!["elementSize"] = 4;
      }),
    );
    expect(s.attributes[1]!.elementSize).toBe(2);
    expect(codes(s.warnings)).toContain("declared-size-mismatch");
  });

  it("warns on a non-identity per-attribute transform", () => {
    const s = parse(
      mutate("autzen", (m) => {
        (m["attributes"] as Record<string, unknown>[])[1]!["scale"] = [0.5];
      }),
    );
    expect(s.attributes[1]!.scale).toEqual([0.5]);
    expect(codes(s.warnings)).toContain("non-identity-attribute-transform");
  });

  it("warns on an inverted range but copies values verbatim", () => {
    const s = parse(
      mutate("synthetic", (m) => {
        const a = (m["attributes"] as Record<string, unknown>[])[1]!;
        a["min"] = [5, 5, 5];
        a["max"] = [1, 1, 1];
      }),
    );
    expect(s.attributes[1]!.min).toEqual([5, 5, 5]);
    expect(s.attributes[1]!.max).toEqual([1, 1, 1]);
    expect(codes(s.warnings)).toContain("inverted-range");
  });

  it("warns on a duplicate attribute name, first wins in the map", () => {
    const s = parse(
      mutate("autzen", (m) => {
        (m["attributes"] as Record<string, unknown>[])[2]!["name"] =
          "intensity";
      }),
    );
    expect(s.attributes).toHaveLength(10);
    expect(codes(s.warnings)).toContain("duplicate-attribute-name");
    // The map keeps the FIRST; both records keep their own offsets.
    expect(s.attributesByName.get("intensity")!.byteOffset).toBe(12);
    expect(s.attributes[2]!.byteOffset).toBe(14);
    expect(s.bytesPerPoint).toBe(35);
  });

  it("warns and falls back when there is no position attribute", () => {
    const s = parse(
      mutate("synthetic", (m) => {
        (m["attributes"] as Record<string, unknown>[])[0]!["name"] = "xyz";
      }),
    );
    expect(codes(s.warnings)).toContain("missing-position-attribute");
    expect(s.tightBoundingBox).toEqual(s.metadata.boundingBox);
  });

  it("warns on a non-cubic bounding box, never throws", () => {
    const s = parse(
      mutate("autzen", (m) => {
        const box = m["boundingBox"] as { max: number[] };
        box.max = [box.max[0]!, box.max[1]!, box.max[2]! + 1000];
      }),
    );
    expect(codes(s.warnings)).toContain("non-cubic-bounding-box");
  });

  it("warns when firstChunkSize is not a multiple of 22, never throws", () => {
    const s = parse(
      mutate("autzen", (m) => {
        (m["hierarchy"] as Record<string, unknown>)["firstChunkSize"] = 5655;
      }),
    );
    expect(s.metadata.hierarchy.firstChunkSize).toBe(5655);
    expect(codes(s.warnings)).toContain("suspicious-first-chunk-size");
  });
});

describe("parse: silent tolerance", () => {
  it("is silent about missing stepSize/depth", () => {
    const s = parse(
      mutate("synthetic", (m) => {
        const h = m["hierarchy"] as Record<string, unknown>;
        delete h["stepSize"];
        delete h["depth"];
      }),
    );
    expect(s.metadata.hierarchy.stepSize).toBeUndefined();
    expect(s.metadata.hierarchy.depth).toBeUndefined();
    expect(s.warnings).toEqual([]);
  });

  it("ignores unknown extra keys at every level", () => {
    const s = parse(
      mutate("autzen", (m) => {
        m["futureField"] = 1;
        (m["attributes"] as Record<string, unknown>[])[0]!["futureField"] = 2;
      }),
    );
    expect(s.warnings).toEqual([]);
    expect(s).not.toHaveProperty("futureField");
  });

  // The synthetic fixture's spacing is 16x off side/128 and is a supported
  // input, so a derived-spacing check would fire on a file we ship.
  it("is silent when spacing disagrees with side/128", () => {
    const s = parse(loadFixtureJson("synthetic"));
    expect(s.metadata.spacing).toBe(1.25);
    expect(s.warnings).toEqual([]);
  });
});

describe("parse: fatal", () => {
  it("rejects an empty attributes array", () => {
    expectThrows(
      () => parse(mutate("autzen", (m) => (m["attributes"] = []))),
      "invalid-metadata",
      "attributes",
    );
  });

  it("rejects a missing or non-array attributes field", () => {
    expectThrows(
      () => parse(mutate("autzen", (m) => delete m["attributes"])),
      "invalid-metadata",
      "attributes",
    );
    expectThrows(
      () => parse(mutate("autzen", (m) => (m["attributes"] = {}))),
      "invalid-metadata",
      "attributes",
    );
  });

  it("rejects an unknown attribute type and names the accepted set", () => {
    const err = expectThrows(
      () =>
        parse(
          mutate("autzen", (m) => {
            (m["attributes"] as Record<string, unknown>[])[0]!["type"] =
              "float128";
          }),
        ),
      "invalid-metadata",
      "attributes[0].type",
    );
    expect(err.message).toContain("float128");
    expect(err.message).toContain("int32");
  });

  // Object.hasOwn, not a bracket lookup — the reference reaches through to
  // Object.prototype here and gets a function back.
  it.each(["constructor", "__proto__", "toString"])(
    "rejects the prototype-pollution type name %s",
    (type) => {
      expectThrows(
        () =>
          parse(
            mutate("autzen", (m) => {
              (m["attributes"] as Record<string, unknown>[])[0]!["type"] = type;
            }),
          ),
        "invalid-metadata",
        "attributes[0].type",
      );
    },
  );

  it.each([0, 1.5, undefined])("rejects numElements %s", (value) => {
    expectThrows(
      () =>
        parse(
          mutate("autzen", (m) => {
            const a = (m["attributes"] as Record<string, unknown>[])[0]!;
            if (value === undefined) delete a["numElements"];
            else a["numElements"] = value;
          }),
        ),
      "invalid-metadata",
      "attributes[0].numElements",
    );
  });

  it("rejects a min whose length disagrees with numElements", () => {
    const err = expectThrows(
      () =>
        parse(
          mutate("autzen", (m) => {
            (m["attributes"] as Record<string, unknown>[])[0]!["min"] = [0, 0];
          }),
        ),
      "invalid-metadata",
      "attributes[0].min",
    );
    expect(err.message).toContain("numElements === 3");
  });

  it("rejects a per-attribute scale of the wrong length", () => {
    expectThrows(
      () =>
        parse(
          mutate("autzen", (m) => {
            (m["attributes"] as Record<string, unknown>[])[0]!["scale"] = [1];
          }),
        ),
      "invalid-metadata",
      "attributes[0].scale",
    );
  });

  it.each([undefined, "", 7])("rejects the attribute name %s", (value) => {
    expectThrows(
      () =>
        parse(
          mutate("autzen", (m) => {
            const a = (m["attributes"] as Record<string, unknown>[])[3]!;
            if (value === undefined) delete a["name"];
            else a["name"] = value;
          }),
        ),
      "invalid-metadata",
      "attributes[3].name",
    );
  });

  it("rejects a zero component in the top-level scale", () => {
    const err = expectThrows(
      () => parse(mutate("autzen", (m) => (m["scale"] = [0.01, 0, 0.01]))),
      "invalid-metadata",
      "scale[1]",
    );
    expect(err.message).toContain("plane");
  });

  it("rejects a 2-element boundingBox.min", () => {
    expectThrows(
      () =>
        parse(
          mutate("autzen", (m) => {
            (m["boundingBox"] as Record<string, unknown>)["min"] = [0, 0];
          }),
        ),
      "invalid-metadata",
      "boundingBox.min",
    );
  });

  it.each([0, -1, undefined])("rejects spacing %s", (value) => {
    expectThrows(
      () =>
        parse(
          mutate("autzen", (m) => {
            if (value === undefined) delete m["spacing"];
            else m["spacing"] = value;
          }),
        ),
      "invalid-metadata",
      "spacing",
    );
  });

  it("rejects a zero firstChunkSize", () => {
    expectThrows(
      () =>
        parse(
          mutate("autzen", (m) => {
            (m["hierarchy"] as Record<string, unknown>)["firstChunkSize"] = 0;
          }),
        ),
      "invalid-metadata",
      "hierarchy.firstChunkSize",
    );
  });

  it.each([-1, 1.5])("rejects a points value of %s", (value) => {
    expectThrows(
      () => parse(mutate("autzen", (m) => (m["points"] = value))),
      "invalid-metadata",
      "points",
    );
  });

  // typeof null === "object" is the sharp case.
  it.each([null, [], "x", 42])("rejects a top level of %s", (value) => {
    expectThrows(() => parse(value), "invalid-metadata", "");
  });

  it.each([
    "attributes",
    "boundingBox",
    "scale",
    "offset",
    "spacing",
    "hierarchy",
  ])("rejects a manifest with %s deleted", (key) => {
    expectThrows(
      () => parse(mutate("autzen", (m) => delete m[key])),
      "invalid-metadata",
      key,
    );
  });
});

describe("parse: foreign formats are named, not shape-errored", () => {
  it("recognises a Potree v1 cloud.js", () => {
    const err = expectThrows(
      () =>
        parse({
          version: "1.7",
          octreeDir: "data",
          boundingBox: { lx: 0, ly: 0, lz: 0, ux: 1, uy: 1, uz: 1 },
          pointAttributes: ["POSITION_CARTESIAN", "COLOR_PACKED"],
          spacing: 1,
          scale: 0.001,
          hierarchyStepSize: 5,
        }),
      "unsupported-format",
    );
    expect(err.message).toContain("Potree 1.x");
  });

  it("recognises an Entwine EPT manifest", () => {
    const err = expectThrows(
      () =>
        parse({
          bounds: [0, 0, 0, 1, 1, 1],
          boundsConforming: [0, 0, 0, 1, 1, 1],
          dataType: "binary",
          hierarchyType: "json",
          schema: [{ name: "X", type: "signed", size: 4 }],
          span: 256,
        }),
      "unsupported-format",
    );
    expect(err.message).toContain("EPT");
  });

  it("recognises a 3D Tiles tileset", () => {
    const err = expectThrows(
      () => parse({ asset: { version: "1.0" }, geometricError: 100, root: {} }),
      "unsupported-format",
    );
    expect(err.message).toContain("3D Tiles");
  });

  it("treats a v1 version string as a format error, not a shape error", () => {
    const err = expectThrows(
      () => parse(mutate("autzen", (m) => (m["version"] = "1.7"))),
      "unsupported-format",
    );
    expect(err.message).toContain("1.7");
    expect(err.message).toContain("2.x");
  });
});

describe("parse: object contract", () => {
  it("returns a deeply frozen source", () => {
    const s = parse(loadFixtureJson("autzen"));
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.metadata)).toBe(true);
    expect(Object.isFrozen(s.metadata.boundingBox)).toBe(true);
    expect(Object.isFrozen(s.metadata.boundingBox.min)).toBe(true);
    expect(Object.isFrozen(s.metadata.hierarchy)).toBe(true);
    expect(Object.isFrozen(s.urls)).toBe(true);
    expect(Object.isFrozen(s.attributes)).toBe(true);
    expect(Object.isFrozen(s.attributes[0])).toBe(true);
    expect(Object.isFrozen(s.attributes[0]!.min)).toBe(true);
    expect(Object.isFrozen(s.warnings)).toBe(true);
  });

  it("provides a usable default transport", () => {
    const s = parse(loadFixtureJson("synthetic"));
    expect(typeof s.transport.fetch).toBe("function");
    expect(s.transport.requestInit).toBeUndefined();
  });
});
