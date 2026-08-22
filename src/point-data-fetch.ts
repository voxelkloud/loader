// All HTTP for octree.bin. INTERNAL to the package's public surface, but
// exported so a caller can stage fetch and decode separately.

import { VoxelkloudError } from "./errors.js";
import { isAbort } from "./hierarchy-fetch.js";
import type { NodeBytes, PointNodeRef } from "./point-data-types.js";
import type { PointCloudSource } from "./types.js";

const DEFAULT_MAX_NODE_BYTES = 64 * 1024 * 1024;

export interface FetchNodeBytesOptions {
  readonly signal?: AbortSignal;
  /** Refuse a node claiming more than this many bytes. Default 64 MiB. */
  readonly maxNodeBytes?: number;
}

function parseContentRangeTotal(header: string | null): number | undefined {
  if (header === null) return undefined;
  const m = /\/(\d+)\s*$/.exec(header);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Fetch exactly one node's byte range from octree.bin.
 *
 * Issues NO request at all when `node.byteSize === 0` — 47 of autzen's nodes.
 * That is not an optimisation: RFC 9110 says an origin IGNORES an unsatisfiable
 * zero-length range, so `bytes=X-(X-1)` is answered 200 with the ENTIRE
 * 372,866,760-byte octree.bin.
 *
 * @throws {VoxelkloudError} `"network-error"`, `"http-error"`,
 *   `"range-request-unsupported"`, `"decode-error"`.
 */
export async function fetchNodeBytes(
  source: PointCloudSource,
  node: PointNodeRef,
  options: FetchNodeBytesOptions = {},
): Promise<NodeBytes> {
  if (node.byteOffset === undefined || node.byteSize === undefined) {
    throw new VoxelkloudError(
      "decode-error",
      `Node ${node.name} has no octree byte range yet; expand it first.`,
      { path: node.name },
    );
  }

  if (node.byteSize === 0) {
    return { buffer: new ArrayBuffer(0), fetched: false };
  }

  const max = options.maxNodeBytes ?? DEFAULT_MAX_NODE_BYTES;
  if (node.byteSize > max) {
    throw new VoxelkloudError(
      "decode-error",
      `Node ${node.name} claims ${node.byteSize} bytes, over the ${max}-byte ` +
        `maxNodeBytes limit.`,
      { path: node.name },
    );
  }

  const url = source.urls.octree;
  const range = `bytes=${node.byteOffset}-${node.byteOffset + node.byteSize - 1}`;
  const headers = new Headers(source.transport.requestInit?.headers);
  headers.set("Range", range);

  let res: Response;
  try {
    res = await source.transport.fetch(url, {
      ...source.transport.requestInit,
      headers,
      signal: options.signal,
    });
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new VoxelkloudError(
      "network-error",
      `Network error fetching ${range} of ${url}.`,
      { url, cause },
    );
  }

  if (res.status === 416) {
    const total = parseContentRangeTotal(res.headers.get("content-range"));
    throw new VoxelkloudError(
      "decode-error",
      `${url} is shorter than the hierarchy claims: the server rejected ` +
        `${range} as unsatisfiable` +
        (total === undefined ? "." : ` (it reports ${total} bytes).`),
      { url, status: 416, path: node.name },
    );
  }

  if (!res.ok) {
    throw new VoxelkloudError(
      "http-error",
      `GET ${range} of ${url} failed: HTTP ${res.status} ${res.statusText}.`,
      { url, status: res.status, path: node.name },
    );
  }

  // A 200 is NEVER adopted here, unlike the hierarchy. hierarchy.bin is ~100 KB
  // and we eventually want all of it; octree.bin is 372 MB and adopting it would
  // mean silently downloading the whole cloud to draw one node.
  if (res.status === 200) {
    throw new VoxelkloudError(
      "range-request-unsupported",
      `${url} answered 200 to a Range request, so the host does not honour ` +
        `Range. Streaming a point cloud requires it — otherwise every node ` +
        `costs the entire octree.bin.`,
      { url, status: 200, path: node.name },
    );
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength !== node.byteSize) {
    throw new VoxelkloudError(
      "range-request-unsupported",
      `${url} answered ${res.status} to ${range} with ${buffer.byteLength} ` +
        `bytes instead of ${node.byteSize}.`,
      { url, status: res.status, path: node.name },
    );
  }

  return { buffer, fetched: true };
}
