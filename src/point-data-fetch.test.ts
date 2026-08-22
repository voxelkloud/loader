import { describe, expect, it } from "vitest";
import { makeTransport } from "./__fixtures__/hierarchy-transport.js";
import {
  FAKE_URLS,
  loadFixtureJson,
  loadFixtureOctree,
} from "./__fixtures__/index.js";
import { isVoxelkloudError } from "./errors.js";
import { parsePointCloudSource } from "./parse.js";
import { fetchNodeBytes } from "./point-data-fetch.js";
import type { PointNodeRef } from "./point-data-types.js";

const octreeBytes = () =>
  new Uint8Array(loadFixtureOctree("autzen.r604421"));

function sourceWith(fetch: ReturnType<typeof makeTransport>["fetch"]) {
  return parsePointCloudSource(loadFixtureJson("autzen"), FAKE_URLS, { fetch });
}

function nodeAt(byteOffset: number, byteSize: number): PointNodeRef {
  return {
    index: 7,
    name: "r604421",
    numPoints: byteSize / 35,
    byteOffset,
    byteSize,
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 1,
    maxY: 1,
    maxZ: 1,
  };
}

async function expectRejects(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (err) {
    if (!isVoxelkloudError(err)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected a ${code} error`);
}

describe("fetchNodeBytes", () => {
  it("issues one Range request and returns exactly the node's bytes", async () => {
    const t = makeTransport(octreeBytes());
    const r = await fetchNodeBytes(sourceWith(t.fetch), nodeAt(0, 3500));
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.range).toBe("bytes=0-3499");
    expect(t.requests[0]!.url).toBe(FAKE_URLS.octree);
    expect(r.buffer.byteLength).toBe(3500);
    expect(r.fetched).toBe(true);
  });

  // 47 of autzen's nodes have byteSize 0. This is not an optimisation: RFC 9110
  // says an origin IGNORES an unsatisfiable zero-length range, so
  // `bytes=X-(X-1)` is answered 200 with the ENTIRE 372,866,760-byte octree.bin.
  it("issues NO request at all for a zero-byte node", async () => {
    const t = makeTransport(octreeBytes());
    const r = await fetchNodeBytes(sourceWith(t.fetch), nodeAt(1234, 0));
    expect(t.requests).toHaveLength(0);
    expect(r.fetched).toBe(false);
    expect(r.buffer.byteLength).toBe(0);
  });

  it("refuses a node that has not been expanded", async () => {
    const t = makeTransport(octreeBytes());
    const node = { ...nodeAt(0, 3500), byteOffset: undefined };
    await expectRejects(
      fetchNodeBytes(sourceWith(t.fetch), node),
      "decode-error",
    );
    expect(t.requests).toHaveLength(0);
  });

  it("refuses a node over maxNodeBytes before issuing anything", async () => {
    const t = makeTransport(octreeBytes());
    await expectRejects(
      fetchNodeBytes(sourceWith(t.fetch), nodeAt(0, 3500), {
        maxNodeBytes: 100,
      }),
      "decode-error",
    );
    expect(t.requests).toHaveLength(0);
  });

  // Unlike the hierarchy, a 200 is NEVER adopted here: hierarchy.bin is ~100 KB
  // and we eventually want all of it, but octree.bin is 372 MB and adopting it
  // would mean downloading the whole cloud to draw one node.
  it("never adopts a 200 response", async () => {
    const t = makeTransport(octreeBytes(), { ignoreRange: true });
    const err = await expectRejects(
      fetchNodeBytes(sourceWith(t.fetch), nodeAt(0, 3500)),
      "range-request-unsupported",
    );
    expect(err.message).toContain("honour Range");
  });

  it("rejects a 206 of the wrong length", async () => {
    const t = makeTransport(octreeBytes(), { truncate: 100 });
    await expectRejects(
      fetchNodeBytes(sourceWith(t.fetch), nodeAt(0, 3500)),
      "range-request-unsupported",
    );
  });

  it("maps a 416 to decode-error naming the file", async () => {
    const t = makeTransport(octreeBytes().slice(0, 10));
    await expectRejects(
      fetchNodeBytes(sourceWith(t.fetch), nodeAt(5000, 3500)),
      "decode-error",
    );
  });

  it("surfaces a non-2xx as http-error with the status", async () => {
    const t = makeTransport(octreeBytes(), { status: 503 });
    const err = await expectRejects(
      fetchNodeBytes(sourceWith(t.fetch), nodeAt(0, 3500)),
      "http-error",
    );
    expect(err.status).toBe(503);
  });

  it("wraps a fetch rejection as network-error", async () => {
    const t = makeTransport(octreeBytes(), {
      reject: () => new TypeError("Failed to fetch"),
    });
    await expectRejects(
      fetchNodeBytes(sourceWith(t.fetch), nodeAt(0, 3500)),
      "network-error",
    );
  });

  it("merges the Range header without dropping the caller's auth", async () => {
    const t = makeTransport(octreeBytes());
    let seen: Headers | undefined;
    const source = parsePointCloudSource(loadFixtureJson("autzen"), FAKE_URLS, {
      fetch: (url, init) => {
        seen = new Headers(init?.headers);
        return t.fetch(url, init);
      },
      requestInit: { headers: { Authorization: "Bearer x" } },
    });
    await fetchNodeBytes(source, nodeAt(0, 3500));
    // Both survive: Range is merged in through `new Headers(...)` rather than
    // replacing the object. Losing the auth here is the potree-core#54 bug, on
    // the octree path this time.
    expect(seen!.get("Authorization")).toBe("Bearer x");
    expect(seen!.get("Range")).toBe("bytes=0-3499");
  });

  it("propagates an abort unwrapped", async () => {
    const t = makeTransport(octreeBytes(), { hang: true });
    const controller = new AbortController();
    const p = fetchNodeBytes(sourceWith(t.fetch), nodeAt(0, 3500), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});
