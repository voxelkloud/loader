import { VoxelkloudError } from "./errors.js";
import type { PointCloudUrls } from "./types.js";

const HIERARCHY_FILE = "hierarchy.bin";
const OCTREE_FILE = "octree.bin";
const METADATA_FILE = "metadata.json";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export interface ResolvePointCloudUrlsOptions {
  /**
   * Base for resolving a relative `input`. Defaults to `document.baseURI` in a
   * browser. In Node there is no default, so a relative input without this
   * throws `"invalid-url"` — deliberately, rather than silently resolving
   * against `process.cwd()`, because a path that means two different things in
   * Node and the browser is worse than an error.
   */
  readonly base?: string | URL;
}

/**
 * Resolve a point cloud's `metadata.json`, `hierarchy.bin` and `octree.bin`
 * URLs from a single input. Pure and synchronous — call it to show a user
 * exactly what will be fetched, before fetching anything.
 *
 * `input` may be a directory URL or the manifest URL itself. All three of these
 * produce identical results:
 *
 * ```ts
 * resolvePointCloudUrls("https://cdn.example/autzen/");
 * resolvePointCloudUrls("https://cdn.example/autzen");        // slash optional
 * resolvePointCloudUrls("https://cdn.example/autzen/metadata.json");
 * ```
 *
 * The trailing slash is optional by design: bare WHATWG resolution of
 * `new URL("octree.bin", "https://h/autzen")` gives `https://h/octree.bin`, one
 * directory too high, and that failure would surface only on the first Range
 * request in Task 4, far from its cause.
 *
 * The input's query string is copied onto all three URLs (correct for gateway
 * tokens and cache-busting); the fragment is dropped. Per-object presigned URLs
 * are NOT covered by query propagation — one S3 v4 signature binds to one key —
 * and the only correct answer there is a custom `fetch`.
 *
 * @throws {VoxelkloudError} `"invalid-url"` — unparseable, relative with no
 *   base, or a protocol outside {http:, https:, file:}.
 */
export function resolvePointCloudUrls(
  input: string | URL,
  options: ResolvePointCloudUrlsOptions = {},
): PointCloudUrls {
  const raw = input instanceof URL ? input.href : String(input);
  const explicit = options.base;
  const base =
    explicit === undefined
      ? (globalThis as { document?: { baseURI?: string } }).document?.baseURI
      : explicit instanceof URL
        ? explicit.href
        : explicit;

  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch (cause) {
    throw new VoxelkloudError(
      "invalid-url",
      `Cannot resolve ${JSON.stringify(raw)} to an absolute URL. Pass an ` +
        `absolute URL, or a relative one together with options.base.`,
      { cause },
    );
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new VoxelkloudError(
      "invalid-url",
      `Unsupported protocol ${JSON.stringify(url.protocol)} in ${url.href}; ` +
        `expected http:, https: or file:.`,
      { url: url.href },
    );
  }

  const path = url.pathname;
  // ONE rule: a pathname ending in `.json` is the manifest, everything else is
  // a directory. Deliberately NOT "the last segment contains a dot", which
  // misreads a real directory like `https://h/data/v1.2` as a file.
  const isManifest = path.toLowerCase().endsWith(".json");
  const dirPath = isManifest
    ? path.slice(0, path.lastIndexOf("/") + 1)
    : path.endsWith("/")
      ? path
      : `${path}/`;

  // Explicit pathname construction, never `new URL(name, url)` and never
  // `${url}/../name` — the latter puts the `/../` inside the query string on
  // any signed URL, where it is never normalised.
  const at = (pathname: string, search: string): string => {
    const u = new URL(url.href);
    u.hash = "";
    u.pathname = pathname;
    u.search = search;
    return u.href;
  };

  return Object.freeze({
    base: at(dirPath, ""),
    metadata: at(isManifest ? path : `${dirPath}${METADATA_FILE}`, url.search),
    hierarchy: at(`${dirPath}${HIERARCHY_FILE}`, url.search),
    octree: at(`${dirPath}${OCTREE_FILE}`, url.search),
  });
}
