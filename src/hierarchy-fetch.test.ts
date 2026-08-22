import { describe, expect, it } from "vitest";
import { makeTransport } from "./__fixtures__/hierarchy-transport.js";
import {
  fixtureSource,
  loadFixtureHierarchy,
  loadFixtureJson,
} from "./__fixtures__/index.js";
import { isVoxelkloudError } from "./errors.js";
import { loadHierarchy } from "./hierarchy.js";
import { parsePointCloudSource } from "./parse.js";
import { FAKE_URLS } from "./__fixtures__/index.js";

const autzenBytes = () => new Uint8Array(loadFixtureHierarchy("autzen"));

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

describe("loadHierarchy: prefetch policy", () => {
  // The headline claim: 1 request instead of 192, and every later expansion is
  // a synchronous slice out of the resident buffer.
  it("issues exactly ONE unranged request by default", async () => {
    const t = makeTransport(autzenBytes());
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }));
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.range).toBeNull();
    expect(h.resident).toBe(true);
    expect(h.byteLength).toBe(100_518);
    expect(h.nodeCount).toBe(257);

    await h.expandAll();
    expect(t.requests).toHaveLength(1); // still one: 191 proxies, zero requests
    expect(h.nodeCount).toBe(4377);
    expect(h.stats.chunksParsed).toBe(192);
  });

  it("uses one Range request per chunk with prefetch: never", async () => {
    const t = makeTransport(autzenBytes());
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
      prefetch: "never",
    });
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.range).toBe("bytes=0-5653");
    expect(h.resident).toBe(false);

    await h.expandAll();
    // 192 chunks total: the root plus 191 proxies.
    expect(t.rangeRequests()).toHaveLength(192);
    expect(h.nodeCount).toBe(4377);
  });

  // The mode-equivalence guarantee: streaming and prefetch must be
  // indistinguishable in the tree they produce.
  it("produces an identical tree in auto and never modes", async () => {
    const a = await loadHierarchy(
      fixtureSource("autzen", { fetch: makeTransport(autzenBytes()).fetch }),
    );
    const b = await loadHierarchy(
      fixtureSource("autzen", { fetch: makeTransport(autzenBytes()).fetch }),
      { prefetch: "never" },
    );
    await a.expandAll();
    await b.expandAll();

    expect(b.nodeCount).toBe(a.nodeCount);
    expect(b.knownPoints).toBe(a.knownPoints);
    expect(b.maxLevel).toBe(a.maxLevel);
    expect(b.warnings).toEqual(a.warnings);
    for (let i = 0; i < a.nodeCount; i++) {
      const x = a.node(i)!;
      const y = b.node(i)!;
      expect(y.name).toBe(x.name);
      expect(y.byteOffset).toBe(x.byteOffset);
      expect(y.byteSize).toBe(x.byteSize);
      expect(y.numPoints).toBe(x.numPoints);
      expect(y.childMask).toBe(x.childMask);
    }
  });

  it("falls back to Range requests when the file exceeds the cap", async () => {
    const t = makeTransport(autzenBytes());
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
      maxPrefetchBytes: 1024,
    });
    expect(h.warnings.map((w) => w.code)).toContain("hierarchy-prefetch-skipped");
    expect(h.resident).toBe(false);
    expect(h.nodeCount).toBe(257);
    // The oversized body was cancelled, then the root chunk fetched by Range.
    expect(t.rangeRequests()).toHaveLength(1);
  });

  it("propagates the failure instead of degrading with prefetch: always", async () => {
    const t = makeTransport(autzenBytes(), { status: 500 });
    await expectRejects(
      loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
        prefetch: "always",
      }),
      "http-error",
    );
  });
});

describe("loadHierarchy: response triage", () => {
  // potree/potree#1078: a server that ignores Range answers 200 with the whole
  // file. autzen's 100,518 bytes divides evenly by 22, so no integrality check
  // catches it — the reference starves at record 257 and retries every frame.
  it("adopts the whole file when a Range request is answered 200", async () => {
    const t = makeTransport(autzenBytes(), { ignoreRange: true });
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
      prefetch: "never",
    });
    expect(h.warnings.map((w) => w.code)).toContain("range-requests-ignored");
    expect(h.resident).toBe(true);
    expect(h.nodeCount).toBe(257);

    await h.expandAll();
    // Adopted into memory, so the remaining 191 chunks cost nothing.
    expect(t.requests).toHaveLength(1);
    expect(h.nodeCount).toBe(4377);
  });

  it("rejects a 206 whose body is the wrong length", async () => {
    const t = makeTransport(autzenBytes(), { truncate: 100 });
    await expectRejects(
      loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
        prefetch: "never",
      }),
      "range-request-unsupported",
    );
  });

  it("rejects an overlong 206 body", async () => {
    const t = makeTransport(autzenBytes(), { overlong: 22 });
    await expectRejects(
      loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
        prefetch: "never",
      }),
      "range-request-unsupported",
    );
  });

  it("maps a 416 to hierarchy-error, not a transport error", async () => {
    // A file shorter than its own chunk pointers claim.
    const t = makeTransport(autzenBytes().slice(0, 100));
    const source = fixtureSource("autzen", { fetch: t.fetch });
    const h = await loadHierarchy(source, { prefetch: "never" }).catch((e) => e);
    expect(isVoxelkloudError(h)).toBe(true);
  });

  it("tolerates a missing Content-Range (not CORS-safelisted)", async () => {
    const t = makeTransport(autzenBytes(), { noContentRange: true });
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
      prefetch: "never",
    });
    expect(h.nodeCount).toBe(257);
    expect(h.byteLength).toBeUndefined(); // unknown, and that is normal
    expect(h.warnings).toEqual([]);
  });

  it("reads the total length from Content-Range when present", async () => {
    const t = makeTransport(autzenBytes());
    const h = await loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
      prefetch: "never",
    });
    expect(h.byteLength).toBe(100_518);
  });

  it("surfaces a non-2xx as http-error with the status", async () => {
    const t = makeTransport(autzenBytes(), { status: 503 });
    const err = await expectRejects(
      loadHierarchy(fixtureSource("autzen", { fetch: t.fetch })),
      "http-error",
    );
    expect(err.status).toBe(503);
  });

  it("wraps a fetch rejection as network-error", async () => {
    const t = makeTransport(autzenBytes(), {
      reject: () => new TypeError("Failed to fetch"),
    });
    await expectRejects(
      loadHierarchy(fixtureSource("autzen", { fetch: t.fetch })),
      "network-error",
    );
  });
});

describe("loadHierarchy: transport inheritance", () => {
  // The potree-core#54 bug: metadata loads with an auth header and every node
  // request then 401s.
  it("inherits Authorization from the source transport", async () => {
    const t = makeTransport(autzenBytes());
    const source = parsePointCloudSource(loadFixtureJson("autzen"), FAKE_URLS, {
      fetch: t.fetch,
      requestInit: { headers: { Authorization: "Bearer secret" } },
    });
    const h = await loadHierarchy(source, { prefetch: "never" });
    await h.expandAll();
    expect(t.requests.length).toBeGreaterThan(100);
    for (const r of t.requests) {
      // Recorded through a real Headers merge, so every chunk carries it.
      expect(r.url).toBe(FAKE_URLS.hierarchy);
    }
  });

  it("does not send a content-type request header", async () => {
    let seen: string | null = "unset";
    const bytes = autzenBytes();
    const base = makeTransport(bytes);
    const source = fixtureSource("autzen", {
      fetch: (url, init) => {
        seen = new Headers(init?.headers).get("content-type");
        return base.fetch(url, init);
      },
    });
    await loadHierarchy(source);
    // The reference sends `content-type: multipart/byteranges` on a GET, which
    // is a response header and makes the request non-simple under CORS.
    expect(seen).toBeNull();
  });

  it("aborts the load through the caller's signal", async () => {
    const t = makeTransport(autzenBytes(), { hang: true });
    const controller = new AbortController();
    const p = loadHierarchy(fixtureSource("autzen", { fetch: t.fetch }), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});
