import { describe, expect, it } from "vitest";
import { fixtureSource, loadFixtureJson } from "./__fixtures__/index.js";
import { FAKE_URLS } from "./__fixtures__/index.js";
import { isVoxelkloudError } from "./errors.js";
import { parsePointCloudSource } from "./parse.js";
import { createPointLayout } from "./point-data-layout.js";

function expectFatal(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    if (!isVoxelkloudError(err)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected a ${code} error`);
}

describe("layout: addressing", () => {
  it("uses the interleaved record offsets under DEFAULT", () => {
    const layout = createPointLayout(fixtureSource("autzen"), {
      attributes: "all",
    });
    expect(layout.isBrotli).toBe(false);
    expect(layout.stride).toBe(35);
    // Every field advances by the stride, and sits at its record offset.
    expect(
      layout.fields.map((f) => [f.name, f.srcOffset, f.srcWidth, f.codec]),
    ).toEqual([
      ["position", 0, 35, "scalar"],
      ["intensity", 12, 35, "scalar"],
      ["return number", 14, 35, "scalar"],
      ["number of returns", 15, 35, "scalar"],
      ["classification", 16, 35, "scalar"],
      ["scan angle rank", 17, 35, "scalar"],
      ["user data", 18, 35, "scalar"],
      ["point source id", 19, 35, "scalar"],
      ["gps-time", 21, 35, "scalar"],
      ["rgb", 29, 35, "scalar"],
    ]);
  });

  it("uses planar prefix widths under BROTLI", () => {
    const layout = createPointLayout(fixtureSource("brotli"), {
      attributes: "all",
    });
    expect(layout.isBrotli).toBe(true);
    // 16 for the morton position and 8 for the morton colour, against the
    // manifest's 12 and 6 — hence 47 rather than bytesPerPoint's 41.
    expect(layout.stride).toBe(47);
    const position = layout.fields[0]!;
    expect(position.srcWidth).toBe(16);
    expect(position.codec).toBe("morton");
    const rgb = layout.fields.find((f) => f.name === "rgb")!;
    expect(rgb.srcWidth).toBe(8);
    expect(rgb.codec).toBe("morton");
    // Prefix sums over ALL manifest attributes: deselecting does not compact
    // the blob, so the offsets must not shift.
    expect(layout.fields.map((f) => f.srcOffset)).toEqual([
      0, 16, 18, 19, 20, 21, 22, 23, 25, 27, 35, 43,
    ]);
  });

  it("keeps BROTLI offsets stable when attributes are deselected", () => {
    const all = createPointLayout(fixtureSource("brotli"), {
      attributes: "all",
    });
    const few = createPointLayout(fixtureSource("brotli"), {
      attributes: ["gps-time"],
    });
    expect(few.stride).toBe(all.stride);
    const gpsAll = all.fields.find((f) => f.name === "gps-time")!;
    const gpsFew = few.fields.find((f) => f.name === "gps-time")!;
    expect(gpsFew.srcOffset).toBe(gpsAll.srcOffset);
  });
});

describe("layout: selection", () => {
  it("defaults to position plus colour", () => {
    const layout = createPointLayout(fixtureSource("autzen"));
    expect(layout.fields.map((f) => f.name)).toEqual(["position", "rgb"]);
    expect(layout.bytesPerPointOut).toBe(16);
  });

  it("always includes position, even for an empty selection", () => {
    const layout = createPointLayout(fixtureSource("autzen"), {
      attributes: [],
    });
    expect(layout.fields.map((f) => f.name)).toEqual(["position"]);
    expect(layout.positionField).toBe(0);
    expect(layout.colorField).toBe(-1);
  });

  it("keeps manifest order regardless of selection order", () => {
    const layout = createPointLayout(fixtureSource("autzen"), {
      attributes: ["rgb", "intensity", "gps-time"],
    });
    expect(layout.fields.map((f) => f.name)).toEqual([
      "position",
      "intensity",
      "gps-time",
      "rgb",
    ]);
  });

  it("rejects an unknown attribute name rather than ignoring it", () => {
    const err = expectFatal(
      () =>
        createPointLayout(fixtureSource("autzen"), {
          attributes: ["intensty"],
        }),
      "unsupported-attribute",
    );
    expect(err.message).toContain("intensty");
    expect(err.message).toContain("intensity");
  });

  it("throws on an explicitly named undecodable type but skips it under all", () => {
    const json = loadFixtureJson("synthetic");
    (json["attributes"] as Record<string, unknown>[]).push({
      name: "big",
      description: "",
      numElements: 1,
      type: "int64",
      min: [0],
      max: [1],
    });
    const source = parsePointCloudSource(json, FAKE_URLS);

    expectFatal(
      () => createPointLayout(source, { attributes: ["big"] }),
      "unsupported-attribute",
    );

    const layout = createPointLayout(source, { attributes: "all" });
    expect(layout.fields.map((f) => f.name)).not.toContain("big");
    expect(layout.warnings.map((w) => w.code)).toContain(
      "undecodable-attribute-type",
    );
  });
});

describe("layout: colour policy", () => {
  it.each([
    ["autzen", 255, 0],
    ["brotli", 65280, 8],
    ["synthetic", 65535, 8],
  ] as const)("%s declares max %i and shifts by %i", (name, max, shift) => {
    const layout = createPointLayout(fixtureSource(name));
    const color = layout.fields[layout.colorField]!;
    expect(color.declaredMax).toBe(max);
    expect(color.shift).toBe(shift);
  });

  it("never shifts under colorFormat: native", () => {
    const layout = createPointLayout(fixtureSource("synthetic"), {
      colorFormat: "native",
    });
    expect(layout.fields[layout.colorField]!.shift).toBe(0);
  });
});

describe("layout: gpu formats", () => {
  it("leaves 1- and 3-component 8/16-bit arrays unbindable at native width", () => {
    const layout = createPointLayout(fixtureSource("autzen"), {
      attributes: "all",
    });
    const byName = new Map(layout.fields.map((f) => [f.name, f]));
    // WebGPU has no uint8x1 or uint16x1 vertex format.
    expect(byName.get("classification")!.gpuFormat).toBeUndefined();
    expect(byName.get("intensity")!.gpuFormat).toBeUndefined();
    // Position and colour are legal at native width, which is why the default
    // selection makes the widening question moot.
    expect(byName.get("position")!.gpuFormat).toBe("float32x3");
    expect(byName.get("rgb")!.gpuFormat).toBe("unorm8x4");
  });

  it("widens every scalar to a 4-byte lane under scalarFormat: gpu", () => {
    const layout = createPointLayout(fixtureSource("autzen"), {
      attributes: "all",
      scalarFormat: "gpu",
    });
    for (const f of layout.fields) {
      expect(f.gpuFormat).toBeDefined();
    }
    const byName = new Map(layout.fields.map((f) => [f.name, f]));
    expect(byName.get("intensity")!.gpuFormat).toBe("uint32");
    expect(byName.get("gps-time")!.gpuFormat).toBe("float32");
    // uint8 with a negative declared min takes the SIGNED lane.
    expect(byName.get("scan angle rank")!.gpuFormat).toBe("sint32");
  });

  it("honours a per-attribute lane override", () => {
    const layout = createPointLayout(fixtureSource("autzen"), {
      attributes: ["intensity"],
      scalarFormat: "gpu",
      lanes: { intensity: "f32" },
    });
    expect(
      layout.fields.find((f) => f.name === "intensity")!.gpuFormat,
    ).toBe("float32");
  });
});

describe("layout: frame and warnings", () => {
  it("is silent on all three real sources", () => {
    for (const name of ["autzen", "brotli", "synthetic"] as const) {
      expect(createPointLayout(fixtureSource(name)).warnings).toEqual([]);
    }
  });

  it("resolves the cloud origin by default and the file origin for int32", () => {
    const source = fixtureSource("autzen");
    expect(createPointLayout(source).origin).toEqual(
      source.metadata.boundingBox.min,
    );
    const int32 = createPointLayout(source, { positionFormat: "int32" });
    expect(int32.originPolicy).toBe("file");
    expect(int32.origin).toEqual(source.metadata.offset);
    // origin: "node" is resolved per node, so the layout carries none.
    expect(createPointLayout(source, { origin: "node" }).origin).toBeUndefined();
  });

  // autzen measures 2^18.83, a factor of 18 of headroom under the 2^23 limit.
  it("warns only when the extent-to-quantum ratio exceeds float32", () => {
    expect(
      createPointLayout(fixtureSource("autzen")).warnings.map((w) => w.code),
    ).not.toContain("position-precision-degraded");

    const json = loadFixtureJson("autzen");
    json["scale"] = [1e-7, 1e-7, 1e-7];
    const layout = createPointLayout(
      parsePointCloudSource(json, FAKE_URLS),
    );
    const w = layout.warnings.find(
      (x) => x.code === "position-precision-degraded",
    );
    expect(w).toBeDefined();
    expect(w!.message).toContain("int32");
  });

  it("rejects an encoding it cannot decode", () => {
    const json = loadFixtureJson("synthetic");
    json["encoding"] = "LZ4";
    // Task 2 only warns; Task 4 is where it becomes fatal.
    const source = parsePointCloudSource(json, FAKE_URLS);
    expect(source.warnings.map((w) => w.code)).toContain("unknown-encoding");
    expectFatal(() => createPointLayout(source), "unsupported-encoding");
  });
});
