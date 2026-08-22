import { createPointDataRequest, decodePointData } from "./point-data-decode.js";
import { decompressNodeBytes } from "./point-data-brotli.js";
import { fetchNodeBytes } from "./point-data-fetch.js";
import { createPointLayout } from "./point-data-layout.js";
import type {
  DecodedPointData,
  LoadPointDataOptions,
  PointNodeRef,
  PointRecordLayout,
} from "./point-data-types.js";
import type { PointCloudSource } from "./types.js";

/**
 * Fetch and decode one node's points.
 *
 * ```ts
 * const source = await loadPointCloudSource("https://cdn.example/autzen/");
 * const tree = await loadHierarchy(source);
 * const node = tree.nodeByName("r0")!;
 * const points = await loadPointData(source, node);
 * points.positions;          // Float32Array, 3 * numPoints
 * points.frame.origin;       // add this to get absolute CRS
 * points.colors?.array;      // Uint8Array RGBA
 * ```
 *
 * Loads exactly the node it is asked for, exactly once, and mutates nothing.
 * There is deliberately no cache, no LRU, no in-flight dedup and no concurrency
 * cap: node selection and budget belong to Task 6 and scene lifetime to Task 8,
 * and returning a value rather than owning shared mutable state removes that
 * whole class of bug structurally.
 *
 * For repeated loads, hoist the layout with {@link createPointLayout} and use
 * the staged functions — the layout is per-source work, not per-node.
 *
 * @throws {VoxelkloudError} `"unsupported-encoding"`, `"unsupported-attribute"`,
 *   `"network-error"`, `"http-error"`, `"range-request-unsupported"`,
 *   `"brotli-unavailable"`, `"decode-error"`.
 * @throws The caller-supplied signal's `AbortError`, unwrapped.
 */
export async function loadPointData(
  source: PointCloudSource,
  node: PointNodeRef,
  options: LoadPointDataOptions = {},
  layout: PointRecordLayout = createPointLayout(source, options),
): Promise<DecodedPointData> {
  const bytes = await fetchNodeBytes(source, node, {
    signal: options.signal,
    maxNodeBytes: options.maxNodeBytes,
  });

  const blob = await decompressNodeBytes(
    layout,
    bytes.buffer,
    node.numPoints,
    options,
  );

  return decodePointData(
    createPointDataRequest(layout, node, blob),
    source,
  );
}
