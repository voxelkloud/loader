// All HTTP for hierarchy.bin. INTERNAL.

import { VoxelkloudError } from "./errors.js";
import type { PointCloudSource } from "./types.js";

/** Internal sentinel: the whole-file prefetch exceeded its cap. Not an error. */
export class PrefetchTooLarge extends Error {
  readonly measured: number | undefined;
  constructor(measured: number | undefined) {
    super("hierarchy prefetch exceeded maxPrefetchBytes");
    this.name = "PrefetchTooLarge";
    this.measured = measured;
  }
}

export function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

function requestInitFor(
  source: PointCloudSource,
  range: string | undefined,
  signal: AbortSignal | undefined,
): RequestInit {
  // Merge via Headers so the Headers, array and record forms all work — the
  // contract documented on PointCloudTransport.requestInit.
  const headers = new Headers(source.transport.requestInit?.headers);
  if (range !== undefined) headers.set("Range", range);
  // The reference sends `content-type: multipart/byteranges` on a GET. That is
  // a response header, it makes the request non-simple under CORS, and it is
  // deliberately not sent here.
  return { ...source.transport.requestInit, headers, signal };
}

async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? ` Body starts: ${JSON.stringify(text.slice(0, 200))}` : "";
  } catch {
    return "";
  }
}

export interface WholeFileResult {
  readonly buffer: ArrayBuffer;
}

/**
 * ONE plain unranged GET of hierarchy.bin.
 *
 * Unranged rather than a Range request for the whole file because a 206 is not
 * `Content-Encoding`-compressed by nginx or any major CDN, whereas a 200 is:
 * autzen's hierarchy.bin is 100,518 B raw but 38,279 B brotli on the wire, and
 * this also removes any dependency on Range support.
 */
export async function fetchWholeHierarchy(
  source: PointCloudSource,
  maxBytes: number,
  signal: AbortSignal | undefined,
  onBytes: (n: number) => void,
): Promise<WholeFileResult> {
  const url = source.urls.hierarchy;
  let res: Response;
  try {
    res = await source.transport.fetch(url, requestInitFor(source, undefined, signal));
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new VoxelkloudError(
      "network-error",
      `Network error fetching ${url}.`,
      { url, cause },
    );
  }

  if (!res.ok) {
    throw new VoxelkloudError(
      "http-error",
      `GET ${url} failed: HTTP ${res.status} ${res.statusText}.` +
        (await bodySnippet(res)),
      { url, status: res.status },
    );
  }

  const declared = res.headers.get("content-length");
  const encoded = res.headers.get("content-encoding");
  // With no content-encoding the header is the decoded size, so an oversized
  // file costs ~0 bytes on the wire.
  if (!encoded && declared !== null && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new PrefetchTooLarge(Number(declared));
  }

  if (res.body) {
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      // The streaming counter is what catches a content-encoded response whose
      // header understated the decoded size.
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PrefetchTooLarge(undefined);
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    onBytes(total);
    return { buffer: out.buffer as ArrayBuffer };
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new PrefetchTooLarge(buffer.byteLength);
  onBytes(buffer.byteLength);
  return { buffer };
}

export interface ChunkResult {
  readonly buffer: ArrayBuffer;
  /** The server ignored Range and sent the whole file; adopt it. */
  readonly wholeFile: boolean;
  /** From `Content-Range: bytes a-b/N`, when present and exposed. */
  readonly totalLength: number | undefined;
}

function parseContentRangeTotal(header: string | null): number | undefined {
  if (header === null) return undefined;
  const m = /\/(\d+)\s*$/.exec(header);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Range GET for one chunk, with full response triage.
 *
 * `byteSize > 0` and `byteSize % 22 === 0` are validated before this is
 * reached, so `bytes=X-(X-1)` — which RFC 9110 says an origin IGNORES, answering
 * 200 with the entire file — can never be emitted.
 */
export async function fetchChunk(
  source: PointCloudSource,
  byteOffset: number,
  byteSize: number,
  maxAdoptBytes: number,
  signal: AbortSignal | undefined,
  onBytes: (n: number) => void,
): Promise<ChunkResult> {
  const url = source.urls.hierarchy;
  const range = `bytes=${byteOffset}-${byteOffset + byteSize - 1}`;

  let res: Response;
  try {
    res = await source.transport.fetch(url, requestInitFor(source, range, signal));
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
      "hierarchy-error",
      `${url} is shorter than hierarchy.bin's own chunk pointers claim: the ` +
        `server rejected ${range} as unsatisfiable` +
        (total === undefined ? "." : ` (it reports ${total} bytes).`),
      { url, status: 416 },
    );
  }

  if (!res.ok) {
    throw new VoxelkloudError(
      "http-error",
      `GET ${range} of ${url} failed: HTTP ${res.status} ${res.statusText}.` +
        (await bodySnippet(res)),
      { url, status: res.status },
    );
  }

  const buffer = await res.arrayBuffer();
  onBytes(buffer.byteLength);

  if (res.status === 200) {
    // The server ignored Range. Recoverable for hierarchy.bin specifically:
    // the file is small and we eventually want all of it. This turns
    // potree/potree#1078 into a working viewer plus one warning.
    if (
      buffer.byteLength >= byteOffset + byteSize &&
      buffer.byteLength <= maxAdoptBytes
    ) {
      return { buffer, wholeFile: true, totalLength: buffer.byteLength };
    }
    throw new VoxelkloudError(
      "range-request-unsupported",
      `${url} answered 200 to a Range request with ${buffer.byteLength} ` +
        `bytes, which does not cover ${range}. The host must honour Range ` +
        `requests to stream a point cloud.`,
      { url, status: 200 },
    );
  }

  if (res.status === 206) {
    if (buffer.byteLength !== byteSize) {
      throw new VoxelkloudError(
        "range-request-unsupported",
        `${url} answered 206 to ${range} with ${buffer.byteLength} bytes ` +
          `instead of ${byteSize}. The host's Range support is broken.`,
        { url, status: 206 },
      );
    }
    return {
      buffer,
      wholeFile: false,
      // Never required: Content-Range is NOT CORS-safelisted, so its absence
      // cross-origin is normal and is not warned about.
      totalLength: parseContentRangeTotal(res.headers.get("content-range")),
    };
  }

  throw new VoxelkloudError(
    "hierarchy-error",
    `${url} answered HTTP ${res.status} to ${range}; expected 206 or 200.`,
    { url, status: res.status },
  );
}
