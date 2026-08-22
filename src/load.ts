import { VoxelkloudError } from "./errors.js";
import { parsePointCloudSource } from "./parse.js";
import type {
  FetchLike,
  PointCloudSource,
  PointCloudTransportOptions,
} from "./types.js";
import { resolvePointCloudUrls } from "./urls.js";
import type { ResolvePointCloudUrlsOptions } from "./urls.js";

// The global fetch MUST be wrapped, not passed by reference — an unbound
// `fetch` throws "Illegal invocation" in browsers.
const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export interface LoadPointCloudOptions
  extends PointCloudTransportOptions,
    ResolvePointCloudUrlsOptions {
  /**
   * Aborts the manifest request only. Deliberately NOT retained on the returned
   * source — later hierarchy/point requests take their own signals. An abort
   * propagates as the original `DOMException`, unwrapped.
   */
  readonly signal?: AbortSignal;
}

/**
 * Fetch and parse a Potree v2 `metadata.json`.
 *
 * ```ts
 * const source = await loadPointCloudSource("https://cdn.example/autzen/", {
 *   requestInit: { headers: { Authorization: `Bearer ${token}` } },
 * });
 * console.log(source.metadata.points, source.bytesPerPoint); // 10653336 35
 * ```
 *
 * Issues EXACTLY ONE network request — the GET for `metadata.json` — and has no
 * other side effects. In particular it does not pre-fetch the root hierarchy
 * chunk. (The reference client fires `loader.load(root)` un-awaited from inside
 * its manifest parse and swallows the failure into a `console.log`, which makes
 * manifest loading both impure and un-failable.) Loading the hierarchy is an
 * explicit, awaitable, cancellable call in Task 3.
 *
 * Equivalent to `parsePointCloudSource(json, resolvePointCloudUrls(input))`
 * with the fetching in between; call those directly when you already have the
 * bytes.
 *
 * @throws {VoxelkloudError} `"invalid-url"`, `"network-error"`,
 *   `"http-error"`, `"invalid-json"`, plus everything
 *   {@link parsePointCloudSource} throws.
 * @throws The caller-supplied signal's `AbortError`, unwrapped.
 */
export async function loadPointCloudSource(
  input: string | URL,
  options: LoadPointCloudOptions = {},
): Promise<PointCloudSource> {
  const urls = resolvePointCloudUrls(input, options);
  const doFetch = options.fetch ?? defaultFetch;

  let response: Response;
  try {
    response = await doFetch(urls.metadata, {
      ...options.requestInit,
      signal: options.signal,
    });
  } catch (cause) {
    // Abort/timeout propagate unwrapped: callers check err.name.
    if (
      cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError")
    ) {
      throw cause;
    }
    throw new VoxelkloudError(
      "network-error",
      `Network error fetching ${urls.metadata}. The host may be unreachable, ` +
        `or the request may have been blocked by CORS.`,
      { url: urls.metadata, cause },
    );
  }

  // Read as text BEFORE checking `ok`: a 404 that serves an HTML error page
  // otherwise surfaces as a bare `SyntaxError: Unexpected token <` with no
  // mention of the status or the URL.
  const body = await response.text();

  if (!response.ok) {
    throw new VoxelkloudError(
      "http-error",
      `GET ${urls.metadata} failed: HTTP ${response.status} ` +
        `${response.statusText} (content-type: ` +
        `${response.headers.get("content-type") ?? "none"}).` +
        (body ? ` Body starts: ${JSON.stringify(body.slice(0, 200))}` : ""),
      { url: urls.metadata, status: response.status },
    );
  }

  // Strip a UTF-8 BOM — common in hand-edited / Windows-written manifests.
  const text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;

  if (text.startsWith("LASF")) {
    throw new VoxelkloudError(
      "unsupported-format",
      `${urls.metadata} is a raw LAS/LAZ/COPC file, not a Potree v2 ` +
        `metadata.json. Run PotreeConverter 2.x over it first.`,
      { url: urls.metadata },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    const head = text.trimStart().slice(0, 200);
    const hint = head.startsWith("<")
      ? " The response looks like an HTML page — usually a 404, a login" +
        " redirect, or a directory listing."
      : /(^|[^\w.])-?(Infinity|NaN)([^\w]|$)/.test(text)
        ? " The body contains an Infinity/NaN literal, which is not valid" +
          " JSON. PotreeConverter emits this for an attribute that was" +
          " declared but never observed."
        : "";
    throw new VoxelkloudError(
      "invalid-json",
      `${urls.metadata} is not valid JSON.${hint} Body starts: ` +
        `${JSON.stringify(head)}`,
      { url: urls.metadata, cause },
    );
  }

  return parsePointCloudSource(json, urls, {
    fetch: doFetch,
    requestInit: options.requestInit,
  });
}
