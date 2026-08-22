import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isVoxelkloudError } from "./errors.js";
import { resolvePointCloudUrls } from "./urls.js";

/** Assert a throw and return the error, narrowed. */
function expectInvalidUrl(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    if (!isVoxelkloudError(err)) throw err;
    expect(err.code).toBe("invalid-url");
    return err;
  }
  throw new Error("expected resolvePointCloudUrls to throw");
}

describe("resolvePointCloudUrls", () => {
  it("resolves siblings of a manifest URL in the same directory", () => {
    expect(resolvePointCloudUrls("https://h/real/metadata.json")).toEqual({
      base: "https://h/real/",
      metadata: "https://h/real/metadata.json",
      hierarchy: "https://h/real/hierarchy.bin",
      octree: "https://h/real/octree.bin",
    });
  });

  it("accepts a directory URL with a trailing slash", () => {
    const urls = resolvePointCloudUrls("https://h/real/");
    expect(urls.metadata).toBe("https://h/real/metadata.json");
    expect(urls.octree).toBe("https://h/real/octree.bin");
  });

  // The WHATWG trap: new URL("octree.bin", "https://h/real") resolves to
  // https://h/octree.bin — one directory too high.
  it("appends the missing trailing slash on a directory URL", () => {
    const urls = resolvePointCloudUrls("https://h/real");
    expect(urls.octree).toBe("https://h/real/octree.bin");
    expect(urls.octree).not.toBe("https://h/octree.bin");
    expect(urls.base).toBe("https://h/real/");
  });

  it("handles a host-only input with and without a slash", () => {
    for (const input of ["https://h", "https://h/"]) {
      const urls = resolvePointCloudUrls(input);
      expect(urls.metadata).toBe("https://h/metadata.json");
      expect(urls.octree).toBe("https://h/octree.bin");
    }
  });

  // Proves the rule is ".json suffix", not "last segment contains a dot".
  it("does not mistake a dotted directory segment for a file", () => {
    const urls = resolvePointCloudUrls("https://h/d/v1.2");
    expect(urls.metadata).toBe("https://h/d/v1.2/metadata.json");
    expect(urls.octree).toBe("https://h/d/v1.2/octree.bin");
  });

  it("honours a renamed manifest", () => {
    const urls = resolvePointCloudUrls("https://h/d/manifest.json");
    expect(urls.metadata).toBe("https://h/d/manifest.json");
    expect(urls.octree).toBe("https://h/d/octree.bin");
  });

  it("propagates the query string to all three URLs", () => {
    const urls = resolvePointCloudUrls("https://h/d/?token=abc");
    expect(urls.metadata).toBe("https://h/d/metadata.json?token=abc");
    expect(urls.hierarchy).toBe("https://h/d/hierarchy.bin?token=abc");
    expect(urls.octree).toBe("https://h/d/octree.bin?token=abc");
    // base is the plain directory — no query, so it is safe to display.
    expect(urls.base).toBe("https://h/d/");
  });

  it("propagates the query from a manifest URL and drops the fragment", () => {
    const urls = resolvePointCloudUrls("https://h/d/metadata.json?sig=x#frag");
    expect(urls.metadata).toBe("https://h/d/metadata.json?sig=x");
    expect(urls.octree).toBe("https://h/d/octree.bin?sig=x");
    expect(urls.octree).not.toContain("#");
  });

  it("preserves a percent-encoded path without double-encoding", () => {
    const urls = resolvePointCloudUrls("https://h/a%20b/metadata.json");
    expect(urls.octree).toBe("https://h/a%20b/octree.bin");
  });

  it("lets the URL parser normalise dot segments", () => {
    expect(resolvePointCloudUrls("https://h/a/b/../c/").base).toBe(
      "https://h/a/c/",
    );
  });

  it("supports the file: scheme for local fixtures", () => {
    const urls = resolvePointCloudUrls(pathToFileURL("/tmp/real/"));
    expect(urls.metadata).toBe("file:///tmp/real/metadata.json");
    expect(urls.octree).toBe("file:///tmp/real/octree.bin");
  });

  it("resolves a relative input against options.base", () => {
    const urls = resolvePointCloudUrls("./real/", { base: "https://h/x/y" });
    expect(urls.base).toBe("https://h/x/real/");
  });

  it("throws on a relative input with no base", () => {
    // Node has no document.baseURI, so this must not silently resolve against
    // process.cwd().
    const err = expectInvalidUrl(() => resolvePointCloudUrls("./real/"));
    expect(err.message).toContain("options.base");
  });

  it("throws on a protocol outside the allowlist", () => {
    for (const input of ["ftp://h/d/", "javascript:alert(1)"]) {
      const err = expectInvalidUrl(() => resolvePointCloudUrls(input));
      expect(err.message).toContain("http:, https: or file:");
    }
  });

  it("throws on garbage input and preserves the cause", () => {
    for (const input of ["", "not a url"]) {
      const err = expectInvalidUrl(() => resolvePointCloudUrls(input));
      expect(err.cause).toBeInstanceOf(Error);
    }
  });
});
