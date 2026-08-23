import { isVoxelkloudError } from "@voxelkloud/core";
import type {
  FormatProbe,
  LoadSourceOptions,
  PointCloudFormat,
  PointCloudSourceBase,
  PointCloudTreeBase,
  PointReader,
} from "@voxelkloud/core";
import { describe, expect, it } from "vitest";
import { ensureDefaultFormats } from "./defaults.js";
import { loadPointCloud, loadPointCloudSource } from "./load.js";
import { FormatRegistry, formats } from "./registry.js";

const SOURCE = { pointCount: 7 } as unknown as PointCloudSourceBase;
const TREE = { nodeCount: 1 } as unknown as PointCloudTreeBase;
const READER = {
  hasPayload: () => true,
  packingFor: () => undefined,
  read: async () => {
    throw new Error("not used");
  },
  dispose: () => undefined,
} as unknown as PointReader;

interface FakeOptions {
  readonly id: string;
  readonly urlScore?: number;
  readonly probeAt?: string | undefined;
  readonly sniffScore?: number | ((p: FormatProbe) => number);
}

function fake(o: FakeOptions) {
  const calls = {
    probeUrl: 0,
    sniff: 0,
    load: 0,
    openTree: 0,
    openPoints: 0,
    lastProbe: undefined as FormatProbe | undefined,
  };
  const format: PointCloudFormat = {
    id: o.id,
    label: o.id,
    sniffUrl: () => o.urlScore ?? 1,
    probeUrl: (url) => {
      calls.probeUrl++;
      return o.probeAt === undefined ? `${url}${o.id}.json` : o.probeAt;
    },
    sniff: (p) => {
      calls.sniff++;
      return typeof o.sniffScore === "function"
        ? o.sniffScore(p)
        : (o.sniffScore ?? 0);
    },
    load: async (_url, opts: LoadSourceOptions) => {
      calls.load++;
      calls.lastProbe = opts.probe;
      return SOURCE;
    },
    openTree: async () => {
      calls.openTree++;
      return TREE;
    },
    openPoints: () => {
      calls.openPoints++;
      return READER;
    },
  };
  return { format, calls };
}

/** Records every URL fetched, and serves whatever the map says. */
function fetcher(bodies: Record<string, string | number>) {
  const seen: string[] = [];
  const fn = async (input: string) => {
    seen.push(input);
    const body = bodies[input];
    if (body === undefined || typeof body === "number") {
      return new Response("not found", { status: typeof body === "number" ? body : 404 });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn, seen };
}

describe("FormatRegistry", () => {
  it("orders candidates by URL confidence and drops zeroes", () => {
    const r = new FormatRegistry();
    r.register(fake({ id: "weak", urlScore: 1 }).format);
    r.register(fake({ id: "strong", urlScore: 3 }).format);
    r.register(fake({ id: "no", urlScore: 0 }).format);
    expect(r.candidates("https://x/").map((f) => f.id)).toEqual(["strong", "weak"]);
  });

  it("REPLACES on a repeated id instead of appending", () => {
    // Registration commonly runs at module scope. A bundler that includes a
    // module twice would otherwise leave two identical candidates competing on
    // equal confidence, and which one won would depend on load order.
    const r = new FormatRegistry();
    r.register(fake({ id: "dup" }).format);
    const second = fake({ id: "dup" });
    r.register(second.format);
    expect(r.ids).toEqual(["dup"]);
    expect(r.all()[0]).toBe(second.format);
  });

  it("unregisters by id and reports whether anything went", () => {
    const r = new FormatRegistry();
    r.register(fake({ id: "a" }).format);
    expect(r.unregister("a")).toBe(true);
    expect(r.unregister("a")).toBe(false);
    expect(r.ids).toEqual([]);
  });

  it("installs Potree v2 on first use, NOT at import time", async () => {
    // Zero-config must keep working. But the registration must not be a
    // module-scope side effect: this package declares `"sideEffects": false`,
    // which licenses a bundler to drop a module that only registers something —
    // and the driver would then vanish in production while dev worked.
    expect(formats.ids).not.toContain("potree-v2");
    ensureDefaultFormats();
    expect(formats.ids).toContain("potree-v2");
    ensureDefaultFormats();
    expect(formats.ids.filter((id) => id === "potree-v2")).toHaveLength(1);
  });
});

describe("loadPointCloudSource: identification", () => {
  it("picks the driver that recognises the document", async () => {
    const a = fake({ id: "a", probeAt: "https://x/a.json", sniffScore: 0 });
    const b = fake({ id: "b", probeAt: "https://x/b.json", sniffScore: 3 });
    formats.register(a.format);
    formats.register(b.format);
    try {
      const f = fetcher({ "https://x/a.json": "{}", "https://x/b.json": "{}" });
      const src = await loadPointCloudSource("https://x/", {
        fetch: f.fn,
        format: undefined,
      });
      expect(src).toBe(SOURCE);
      expect(b.calls.load).toBe(1);
      expect(a.calls.load).toBe(0);
    } finally {
      formats.unregister("a");
      formats.unregister("b");
    }
  });

  it("fetches each DISTINCT probe document once, not once per driver", async () => {
    // Two drivers identifying themselves from the same file must not cost two
    // round trips — that cost would scale with how many drivers are installed,
    // which is exactly the wrong thing to make expensive.
    const a = fake({ id: "a", probeAt: "https://x/shared.json", sniffScore: 0, urlScore: 2 });
    const b = fake({ id: "b", probeAt: "https://x/shared.json", sniffScore: 3, urlScore: 1 });
    formats.register(a.format);
    formats.register(b.format);
    try {
      const f = fetcher({ "https://x/shared.json": "{}" });
      await loadPointCloudSource("https://x/", { fetch: f.fn });
      expect(f.seen.filter((u) => u === "https://x/shared.json")).toHaveLength(1);
    } finally {
      formats.unregister("a");
      formats.unregister("b");
    }
  });

  it("stops probing once a driver is decisive", async () => {
    const first = fake({ id: "first", probeAt: "https://x/1.json", sniffScore: 3, urlScore: 3 });
    const later = fake({ id: "later", probeAt: "https://x/2.json", sniffScore: 3, urlScore: 1 });
    formats.register(first.format);
    formats.register(later.format);
    try {
      const f = fetcher({ "https://x/1.json": "{}", "https://x/2.json": "{}" });
      await loadPointCloudSource("https://x/", { fetch: f.fn });
      expect(f.seen).toEqual(["https://x/1.json"]);
      expect(later.calls.sniff).toBe(0);
    } finally {
      formats.unregister("first");
      formats.unregister("later");
    }
  });

  it("hands the winning driver the document it already fetched", async () => {
    // Without this, identifying a cloud costs every load a duplicate GET of the
    // manifest.
    const a = fake({ id: "a", probeAt: "https://x/a.json", sniffScore: 3 });
    formats.register(a.format);
    try {
      const f = fetcher({ "https://x/a.json": '{"v":1}' });
      await loadPointCloudSource("https://x/", { fetch: f.fn });
      expect(a.calls.lastProbe?.url).toBe("https://x/a.json");
      expect(a.calls.lastProbe?.json).toEqual({ v: 1 });
      expect(a.calls.lastProbe?.contentType).toBe("application/json");
    } finally {
      formats.unregister("a");
    }
  });

  it("treats an unreachable candidate as an answer, not a failure", async () => {
    // A 404 on one driver's document is how "not this format" presents. Letting
    // it escape would turn "this is a B cloud" into "the host is down".
    const a = fake({ id: "a", probeAt: "https://x/a.json", sniffScore: 3, urlScore: 3 });
    const b = fake({ id: "b", probeAt: "https://x/b.json", sniffScore: 3, urlScore: 1 });
    formats.register(a.format);
    formats.register(b.format);
    try {
      const f = fetcher({ "https://x/b.json": "{}" });
      const src = await loadPointCloudSource("https://x/", { fetch: f.fn });
      expect(src).toBe(SOURCE);
      expect(b.calls.load).toBe(1);
    } finally {
      formats.unregister("a");
      formats.unregister("b");
    }
  });

  it("throws unsupported-format naming what was tried and what was served", async () => {
    const a = fake({ id: "a", probeAt: "https://x/a.json", sniffScore: 0 });
    formats.register(a.format);
    try {
      const f = fetcher({ "https://x/a.json": "<html>nope</html>" });
      await expect(
        loadPointCloudSource("https://x/", { fetch: f.fn }),
      ).rejects.toSatisfy((e: unknown) => {
        if (!isVoxelkloudError(e)) return false;
        return (
          e.code === "unsupported-format" &&
          e.message.includes("https://x/a.json") &&
          e.message.includes("nope")
        );
      });
    } finally {
      formats.unregister("a");
    }
  });

  it("rejects a relative URL with invalid-url, not a stack from fetch", async () => {
    await expect(loadPointCloudSource("./cloud/")).rejects.toSatisfy(
      (e: unknown) => isVoxelkloudError(e) && e.code === "invalid-url",
    );
  });
});

describe("loadPointCloudSource: pinning a driver", () => {
  it("skips sniffing entirely when `format` names one", async () => {
    const a = fake({ id: "pinned", probeAt: "https://x/a.json", sniffScore: 0 });
    formats.register(a.format);
    try {
      const f = fetcher({});
      const src = await loadPointCloudSource("https://x/", {
        fetch: f.fn,
        format: "pinned",
      });
      expect(src).toBe(SOURCE);
      expect(f.seen).toEqual([]);
      expect(a.calls.sniff).toBe(0);
    } finally {
      formats.unregister("pinned");
    }
  });

  it("throws rather than falling back when the pinned id is not registered", async () => {
    // The pin exists so a wrong guess is an error. Falling back would make it
    // decoration.
    await expect(
      loadPointCloudSource("https://x/", { format: "nope" }),
    ).rejects.toSatisfy(
      (e: unknown) => isVoxelkloudError(e) && e.code === "unsupported-format",
    );
  });
});

describe("loadPointCloud", () => {
  it("returns source, tree and the driver that won", async () => {
    const a = fake({ id: "a", probeAt: "https://x/a.json", sniffScore: 3 });
    formats.register(a.format);
    try {
      const f = fetcher({ "https://x/a.json": "{}" });
      const out = await loadPointCloud("https://x/", { fetch: f.fn });
      expect(out.source).toBe(SOURCE);
      expect(out.tree).toBe(TREE);
      expect(out.format.id).toBe("a");
      expect(a.calls.openTree).toBe(1);
    } finally {
      formats.unregister("a");
    }
  });
});

describe("loadPointCloudSource: the identification probe", () => {
  it("asks for a range and stops at the cap", async () => {
    // THE BUG THIS PINS. A driver names the document that identifies it, and
    // for a binary format that document IS the point cloud: COPC is recognised
    // by the `LASF` at byte 0 of a file that can be gigabytes. The probe used
    // to `await response.text()` on it, so pointing the demo at a 2 GB public
    // COPC downloaded 2 GB and text-decoded it to look at four bytes.
    let ranges: (string | null)[] = [];
    let served = 0;
    let cancelled = false;

    const fn = async (input: string, init?: RequestInit) => {
      ranges.push(new Headers(init?.headers).get("Range"));
      // A host that IGNORES Range and streams the whole thing, which is the
      // case the cap has to survive on its own.
      const chunk = new Uint8Array(16 * 1024);
      chunk.set(new TextEncoder().encode("LASF"));
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (served >= 64) {
            controller.close();
            return;
          }
          served++;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    };

    const a = fake({
      id: "las-like",
      probeAt: "https://x/big.copc.laz",
      sniffScore: (p: FormatProbe) => (p.head.startsWith("LASF") ? 3 : 0),
    });
    formats.register(a.format);
    try {
      const source = await loadPointCloudSource("https://x/", { fetch: fn });
      expect(source).toBe(SOURCE);
      // The magic bytes still arrived, so identification still worked.
      expect(a.calls.lastProbe?.head.startsWith("LASF")).toBe(true);
      // Every probe asked for a range. There is more than one because the
      // default Potree driver is registered too and a bare directory is its
      // shape as much as anyone's — it probes `metadata.json`, gets these same
      // bytes, and correctly declines them.
      expect(ranges.length).toBeGreaterThanOrEqual(1);
      expect(new Set(ranges)).toEqual(new Set(["bytes=0-65535"]));
      // And when the host ignored the range, the read stopped anyway. 64 KiB
      // is four 16 KiB chunks per probe; the stream would have served 1 MiB
      // each.
      expect(served).toBeLessThanOrEqual(5 * ranges.length);
      expect(cancelled).toBe(true);
    } finally {
      formats.unregister("las-like");
    }
  });

  it("still hands a small manifest to the driver, parsed", async () => {
    // The cap must not cost the round trip it exists to save: a driver that
    // recognises the document it was about to fetch parses the probe instead.
    const a = fake({ id: "a", probeAt: "https://x/a.json", sniffScore: 3 });
    formats.register(a.format);
    try {
      const f = fetcher({ "https://x/a.json": '{"version":"2.0"}' });
      await loadPointCloudSource("https://x/", { fetch: f.fn });
      expect(a.calls.lastProbe?.json).toEqual({ version: "2.0" });
    } finally {
      formats.unregister("a");
    }
  });
});

