// TEST-ONLY. Never imported by src/index.ts, so it never reaches dist.
//
// The two manifests are vendored byte-for-byte from demo/data/{real,synthetic}
// because `demo/data/*` is gitignored — a fresh clone or CI checkout has none
// of it, and a suite that depended on it would be red on every clean machine.
// fixtures.test.ts guards the copies against drift when the demo data IS
// present.

import { readFileSync } from "node:fs";
import { parsePointCloudSource } from "../parse.js";
import type {
  PointCloudSource,
  PointCloudTransportOptions,
} from "../types.js";

export type FixtureName = "autzen" | "synthetic" | "brotli";

const FILES: Record<FixtureName, string> = {
  autzen: "./autzen.metadata.json",
  synthetic: "./synthetic.metadata.json",
  brotli: "./brotli.metadata.json",
};

export function loadFixtureText(name: FixtureName): string {
  return readFileSync(new URL(FILES[name], import.meta.url), "utf8");
}

export function loadFixtureJson(name: FixtureName): Record<string, unknown> {
  return JSON.parse(loadFixtureText(name)) as Record<string, unknown>;
}

/**
 * Deep-clone a fixture and apply one mutation, so a test can express exactly
 * the delta it cares about and nothing else.
 */
export function mutate(
  name: FixtureName,
  fn: (m: Record<string, unknown>) => void,
): Record<string, unknown> {
  const clone = loadFixtureJson(name);
  fn(clone);
  return clone;
}

/**
 * Byte lengths of the binaries in demo/data, hardcoded so the stride invariant
 * can be asserted with zero I/O. Cross-checked against the real files by
 * fixtures.test.ts whenever they exist.
 */
export const FIXTURE_BINARY_SIZES = {
  autzen: { octree: 372_866_760, hierarchy: 100_518 },
  synthetic: { octree: 315_000, hierarchy: 198 },
  // BROTLI: octree.bin is compressed, so bytesPerPoint * points does NOT equal
  // its length — 41 * 341_989 = 14_021_549 is 7x the real 2_005_734.
  brotli: { octree: 2_005_734, hierarchy: 2_574 },
} as const;

/** The vendored hierarchy.bin for a fixture, as a standalone ArrayBuffer. */
export function loadFixtureHierarchy(name: FixtureName): ArrayBuffer {
  const buf = readFileSync(
    new URL(`./${name}.hierarchy.bin`, import.meta.url),
  );
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/**
 * A real Task 2 `PointCloudSource` over a fixture manifest, so hierarchy tests
 * exercise the actual `source.transport` path rather than a hand-built stub.
 */
export function fixtureSource(
  name: FixtureName,
  transport?: PointCloudTransportOptions,
): PointCloudSource {
  return parsePointCloudSource(loadFixtureJson(name), FAKE_URLS, transport);
}

/** One vendored slice of a real octree.bin. */
export function loadFixtureOctree(slice: OctreeSliceName): ArrayBuffer {
  const buf = readFileSync(new URL(`./${slice}.octree.bin`, import.meta.url));
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

export type OctreeSliceName =
  | "autzen.r604421"
  | "brotli.r10"
  | "brotli.r11"
  | "brotli.r37"
  | "synthetic.first256";

/**
 * The node metadata for each vendored slice, captured from the real hierarchy,
 * so a decode test can build a `PointNodeRef` without loading a hierarchy.
 *
 * `byteOffset` is 0 because each slice is a standalone buffer; the ORIGINAL
 * offset in the full octree.bin is recorded as `sourceByteOffset` for the drift
 * guard.
 */
export const FIXTURE_NODES = Object.freeze({
  "autzen.r604421": {
    fixture: "autzen" as const,
    index: 1,
    name: "r604421",
    numPoints: 100,
    byteOffset: 0,
    byteSize: 3500,
    sourceByteOffset: 67_674_110,
  },
  "brotli.r10": {
    fixture: "brotli" as const,
    index: 1,
    name: "r10",
    numPoints: 14,
    byteOffset: 0,
    byteSize: 168,
    sourceByteOffset: 706_567,
  },
  "brotli.r11": {
    fixture: "brotli" as const,
    index: 2,
    name: "r11",
    numPoints: 3,
    byteOffset: 0,
    byteSize: 78,
    sourceByteOffset: 706_735,
  },
  "brotli.r37": {
    fixture: "brotli" as const,
    index: 3,
    name: "r37",
    numPoints: 3,
    byteOffset: 0,
    byteSize: 71,
    sourceByteOffset: 1_197_492,
  },
  "synthetic.first256": {
    fixture: "synthetic" as const,
    index: 0,
    name: "r",
    numPoints: 256,
    byteOffset: 0,
    byteSize: 4608,
    sourceByteOffset: 0,
  },
});

/** Stand-in URLs for tests that exercise parsing rather than resolution. */
export const FAKE_URLS = Object.freeze({
  base: "https://example.test/cloud/",
  metadata: "https://example.test/cloud/metadata.json",
  hierarchy: "https://example.test/cloud/hierarchy.bin",
  octree: "https://example.test/cloud/octree.bin",
});
