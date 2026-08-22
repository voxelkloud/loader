// Drift guard for the vendored manifests.
//
// The suite runs entirely off the copies in __fixtures__ so a fresh clone (with
// no demo/data, which is gitignored) is green. When the demo data IS present,
// these tests prove the copies still match it — otherwise they skip with a
// message rather than failing on a machine that simply has not built the data.

import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURE_BINARY_SIZES, FIXTURE_NODES } from "./__fixtures__/index.js";

const demoPath = (rel: string) =>
  fileURLToPath(new URL(`../../../demo/data/${rel}`, import.meta.url));

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

const CASES = [
  { label: "autzen", demo: "real/metadata.json", vendored: "autzen.metadata.json" },
  {
    label: "synthetic",
    demo: "synthetic/metadata.json",
    vendored: "synthetic.metadata.json",
  },
  {
    label: "brotli",
    demo: "brotli/metadata.json",
    vendored: "brotli.metadata.json",
  },
  {
    label: "autzen hierarchy",
    demo: "real/hierarchy.bin",
    vendored: "autzen.hierarchy.bin",
  },
  {
    label: "brotli hierarchy",
    demo: "brotli/hierarchy.bin",
    vendored: "brotli.hierarchy.bin",
  },
  {
    label: "synthetic hierarchy",
    demo: "synthetic/hierarchy.bin",
    vendored: "synthetic.hierarchy.bin",
  },
] as const;

describe("vendored fixtures match demo/data", () => {
  for (const { label, demo, vendored } of CASES) {
    const source = demoPath(demo);
    const target = fixturePath(vendored);
    const present = existsSync(source);

    it.skipIf(!present)(
      `${label} manifest is byte-identical to demo/data/${demo}`,
      () => {
        expect(readFileSync(target)).toEqual(readFileSync(source));
      },
    );

    if (!present) {
      it.skip(`${label}: demo/data/${demo} not built on this machine`, () => {});
    }
  }
});

describe("hardcoded binary sizes match demo/data", () => {
  const BINARIES = [
    ["autzen", "real/octree.bin", FIXTURE_BINARY_SIZES.autzen.octree],
    ["autzen", "real/hierarchy.bin", FIXTURE_BINARY_SIZES.autzen.hierarchy],
    ["synthetic", "synthetic/octree.bin", FIXTURE_BINARY_SIZES.synthetic.octree],
    [
      "synthetic",
      "synthetic/hierarchy.bin",
      FIXTURE_BINARY_SIZES.synthetic.hierarchy,
    ],
    ["brotli", "brotli/octree.bin", FIXTURE_BINARY_SIZES.brotli.octree],
    ["brotli", "brotli/hierarchy.bin", FIXTURE_BINARY_SIZES.brotli.hierarchy],
  ] as const;

  for (const [label, rel, expected] of BINARIES) {
    const source = demoPath(rel);
    it.skipIf(!existsSync(source))(
      `${label}: ${rel} is ${expected} bytes`,
      () => {
        expect(statSync(source).size).toBe(expected);
      },
    );
  }
});

// The octree slices are ranges out of files far too large to vendor, so the
// guard re-reads the same range and compares, rather than diffing whole files.
describe("vendored octree slices match demo/data", () => {
  const DIR = { autzen: "real", brotli: "brotli", synthetic: "synthetic" };

  for (const [slice, meta] of Object.entries(FIXTURE_NODES)) {
    const source = demoPath(`${DIR[meta.fixture]}/octree.bin`);
    it.skipIf(!existsSync(source))(
      `${slice} is byte-identical to its range in demo/data`,
      () => {
        const expected = readFileSync(fixturePath(`${slice}.octree.bin`));
        const actual = Buffer.alloc(meta.byteSize);
        const fd = openSync(source, "r");
        try {
          readSync(fd, actual, 0, meta.byteSize, meta.sourceByteOffset);
        } finally {
          closeSync(fd);
        }
        expect(actual).toEqual(expected);
      },
    );
  }
});
