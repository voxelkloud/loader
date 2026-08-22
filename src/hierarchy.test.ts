import { describe, expect, it } from "vitest";
import { makeTransport } from "./__fixtures__/hierarchy-transport.js";
import { fixtureSource, loadFixtureHierarchy } from "./__fixtures__/index.js";
import { createHierarchy, loadHierarchy } from "./hierarchy.js";
import type { HierarchyNode, PointCloudHierarchy } from "./hierarchy-types.js";

const autzenBytes = () => new Uint8Array(loadFixtureHierarchy("autzen"));

/**
 * A streaming tree whose root chunk loaded cleanly, but where every SUBSEQUENT
 * chunk request hits `behaviour`.
 *
 * The split matters: these tests are about what happens to a proxy expansion
 * mid-session, so the root must succeed first — otherwise `loadHierarchy`
 * itself fails and there is no tree to make assertions about.
 */
async function streaming(
  behaviour: Parameters<typeof makeTransport>[1] = {},
  options = {},
) {
  const good = makeTransport(autzenBytes());
  const bad = makeTransport(autzenBytes(), behaviour);
  const requests: unknown[] = [];
  let served = 0;

  const source = fixtureSource("autzen", {
    fetch: (url, init) => {
      requests.push(url);
      served++;
      return served === 1 ? good.fetch(url, init) : bad.fetch(url, init);
    },
  });
  const h = await loadHierarchy(source, { prefetch: "never", ...options });
  return { h, t: bad, allRequests: requests };
}

function firstProxy(h: PointCloudHierarchy): HierarchyNode {
  for (const n of h.nodes()) {
    if (n.state === "unexpanded" && n.chunk !== undefined) return n;
  }
  throw new Error("no unexpanded proxy found");
}

describe("hierarchy: expansion state machine", () => {
  it("walks unexpanded -> expanding -> expanded", async () => {
    const { h } = await streaming();
    const proxy = firstProxy(h);
    expect(proxy.state).toBe("unexpanded");
    expect(proxy.childMask).toBeUndefined();
    expect(proxy.byteOffset).toBeUndefined();
    // numPoints IS known while unexpanded — that is what lets the LOD budget
    // cover the top of the tree after one request.
    expect(proxy.numPoints).toBeGreaterThan(0);

    const p = h.expand(proxy);
    expect(proxy.state).toBe("expanding");
    await p;
    expect(proxy.state).toBe("expanded");
    expect(proxy.childMask).toBeDefined();
    expect(proxy.byteOffset).toBeDefined();
    expect(Object.isFrozen(proxy)).toBe(true);
  });

  it("resolves to the same node object, never a replacement", async () => {
    const { h } = await streaming();
    const proxy = firstProxy(h);
    const parent = proxy.parent!;
    const slot = proxy.childIndex;
    const returned = await h.expand(proxy);
    expect(returned).toBe(proxy);
    expect(parent.children[slot]).toBe(proxy);
  });

  it("is idempotent on an already-expanded node", async () => {
    const { h } = await streaming();
    const before = h.stats.requests;
    expect(await h.expand(h.root)).toBe(h.root);
    expect(h.stats.requests).toBe(before);
  });

  it("rejects a node that does not belong to this hierarchy", async () => {
    const { h } = await streaming();
    const other = createHierarchy(fixtureSource("autzen"), {
      buffer: loadFixtureHierarchy("autzen"),
    });
    await expect(h.expand(other.root)).rejects.toThrow(/does not belong/);
  });
});

describe("hierarchy: dedup and concurrency", () => {
  it("shares ONE request between concurrent callers", async () => {
    const { h } = await streaming();
    const proxy = firstProxy(h);
    const before = h.stats.requests;
    const [a, b, c] = await Promise.all([
      h.expand(proxy),
      h.expand(proxy),
      h.expand(proxy),
    ]);
    expect(h.stats.requests).toBe(before + 1);
    expect(a).toBe(proxy);
    expect(b).toBe(proxy);
    expect(c).toBe(proxy);
  });

  it("honours maxConcurrentChunkRequests", async () => {
    const t = makeTransport(autzenBytes());
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
      prefetch: "never",
      maxConcurrentChunkRequests: 3,
    });
    await h.expandAll();
    expect(h.nodeCount).toBe(4377);
    expect(t.peakConcurrency()).toBeLessThanOrEqual(3);
  });

  it("reports pendingCount while requests are in flight", async () => {
    const { h } = await streaming({ hang: true });
    const proxy = firstProxy(h);
    const controller = new AbortController();
    const p = h.expand(proxy, { signal: controller.signal });
    expect(h.pendingCount).toBe(1);
    controller.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});

describe("hierarchy: the three-way failure outcome", () => {
  // ABORT -> RELEASE. An abort is a caller-side decision carrying zero
  // information about the resource; poisoning on abort would let a fast camera
  // pan permanently blind subtrees.
  it("releases without poisoning when a caller aborts", async () => {
    const { h } = await streaming({ hang: true });
    const proxy = firstProxy(h);
    const controller = new AbortController();
    const p = h.expand(proxy, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toThrow(/abort/i);

    expect(proxy.state).toBe("unexpanded");
    expect(proxy.failure).toBeUndefined();
  });

  it("does not disturb other callers when one of them aborts", async () => {
    const { h } = await streaming();
    const proxy = firstProxy(h);
    const controller = new AbortController();
    const aborted = h.expand(proxy, { signal: controller.signal });
    const kept = h.expand(proxy);
    controller.abort();
    await expect(aborted).rejects.toThrow(/abort/i);
    // The shared request is only cancelled when the LAST caller lets go.
    expect(await kept).toBe(proxy);
    expect(proxy.state).toBe("expanded");
  });

  // DETERMINISTIC -> POISON. This is the rule that kills the reference's
  // per-frame retry storm.
  it("poisons permanently on a deterministic failure", async () => {
    const { h } = await streaming({ status: 404 });
    const proxy = firstProxy(h);
    await expect(h.expand(proxy)).rejects.toThrow();
    expect(proxy.state).toBe("failed");
    expect(proxy.failure!.retryAfter).toBeUndefined();

    // Every later attempt rejects instantly from cache, with no request.
    const t2 = h.stats.requests;
    const err = await h.expand(proxy).catch((e) => e);
    expect(err).toBe(proxy.failure!.error);
    expect(h.stats.requests).toBe(t2);
  });

  it("makes requestExpand a no-op on a poisoned node", async () => {
    const { h } = await streaming({ status: 404 });
    const proxy = firstProxy(h);
    await expect(h.expand(proxy)).rejects.toThrow();
    const before = h.stats.requests;
    for (let frame = 0; frame < 100; frame++) h.requestExpand(proxy);
    expect(h.stats.requests).toBe(before);
  });

  // TRANSIENT -> BACK OFF, then permanent once maxAttempts is exhausted.
  it("escalates a transient failure to permanent after maxAttempts", async () => {
    let clock = 1000;
    const { h } = await streaming(
      { reject: () => new TypeError("Failed to fetch") },
      { maxAttempts: 2, now: () => clock, retryDelayMs: () => 100 },
    );
    const proxy = firstProxy(h);

    await expect(h.expand(proxy)).rejects.toThrow();
    expect(proxy.failure!.attempts).toBe(1);
    expect(proxy.failure!.retryAfter).toBe(1100); // still retryable

    clock = 2000;
    await expect(h.expand(proxy)).rejects.toThrow();
    expect(proxy.failure!.attempts).toBe(2);
    // maxAttempts reached: no further implicit retry, ever.
    expect(proxy.failure!.retryAfter).toBeUndefined();

    clock = 99_999;
    const cached = proxy.failure!.error;
    await expect(h.expand(proxy)).rejects.toBe(cached);
  });

  it("retries a transient failure only after the backoff window", async () => {
    let clock = 1000;
    // Fail the first proxy request only, then behave.
    const { h } = await streaming(
      { flaky: 1 },
      { maxAttempts: 5, now: () => clock, retryDelayMs: () => 500 },
    );
    const proxy = firstProxy(h);
    await expect(h.expand(proxy)).rejects.toThrow();
    expect(proxy.state).toBe("failed");
    expect(proxy.failure!.attempts).toBe(1);
    expect(proxy.failure!.retryAfter).toBe(1500);

    // Inside the window: rejects from cache with no request.
    const before = h.stats.requests;
    await expect(h.expand(proxy)).rejects.toThrow();
    expect(h.stats.requests).toBe(before);

    // Past the window: retried, and this time the transport behaves.
    clock = 1600;
    expect(await h.expand(proxy)).toBe(proxy);
    expect(proxy.state).toBe("expanded");
    expect(proxy.failure).toBeUndefined();
  });

  it("clears a permanent failure only through retry()", async () => {
    const { h } = await streaming({ status: 404 });
    const proxy = firstProxy(h);
    await expect(h.expand(proxy)).rejects.toThrow();
    expect(proxy.state).toBe("failed");
    h.retry(proxy);
    expect(proxy.state).toBe("unexpanded");
    expect(proxy.failure).toBeUndefined();
  });
});

describe("hierarchy: dispose", () => {
  it("aborts in-flight work and leaves the tree readable", async () => {
    const { h } = await streaming({ hang: true });
    const proxy = firstProxy(h);
    const p = h.expand(proxy).catch((e) => e);
    expect(h.pendingCount).toBe(1);

    h.dispose();
    await p;
    expect(h.pendingCount).toBe(0);
    expect(proxy.state).toBe("unexpanded");
    expect(proxy.failure).toBeUndefined();
    // The tree stays readable and expansion can resume later.
    expect(h.nodeCount).toBe(257);
    expect(h.root.state).toBe("expanded");
  });
});

describe("hierarchy: tryExpandSync", () => {
  it("expands from resident bytes with zero requests", async () => {
    const t = makeTransport(autzenBytes());
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }));
    const before = t.requests.length;
    let expandedCount = 0;
    for (const n of [...h.nodes()]) {
      if (n.state === "unexpanded" && h.tryExpandSync(n)) expandedCount++;
    }
    expect(expandedCount).toBeGreaterThan(0);
    expect(t.requests).toHaveLength(before);
  });

  it("returns false rather than throwing when bytes are absent", async () => {
    const { h } = await streaming();
    const proxy = firstProxy(h);
    expect(h.resident).toBe(false);
    expect(() => h.tryExpandSync(proxy)).not.toThrow();
    expect(h.tryExpandSync(proxy)).toBe(false);
    expect(proxy.state).toBe("unexpanded");
  });

  it("reports a chunk pointer past EOF as corruption when fully resident", async () => {
    // Truncate the file so the root's own chunk still fits but proxies do not.
    const bytes = autzenBytes().slice(0, 6000);
    const h = createHierarchy(fixtureSource("autzen"), { buffer: bytes });
    expect(h.tryExpandSync(h.root)).toBe(true);
    const proxy = firstProxy(h);
    expect(h.tryExpandSync(proxy)).toBe(false);
    // With the whole file resident, "not in the buffer" means corrupt, not
    // "not fetched yet".
    expect(proxy.state).toBe("failed");
    expect(proxy.failure!.error.code).toBe("hierarchy-error");
  });
});

describe("hierarchy: stats", () => {
  it("counts requests, bytes and chunks", async () => {
    const t = makeTransport(autzenBytes());
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }));
    await h.expandAll();
    expect(h.stats.requests).toBe(1);
    expect(h.stats.bytesFetched).toBe(100_518);
    expect(h.stats.chunksParsed).toBe(192);
  });

  it("counts 192 requests in streaming mode", async () => {
    const t = makeTransport(autzenBytes());
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
      prefetch: "never",
    });
    await h.expandAll();
    expect(h.stats.requests).toBe(192);
    expect(h.stats.chunksParsed).toBe(192);
    // The whole point of the eager-bytes default: 192 requests totalling
    // ~100 KB uncompressed, against ONE request of 38 KB brotli on the wire.
    expect(h.stats.bytesFetched).toBeLessThanOrEqual(100_518);
  });
});
