import { VoxelkloudError } from "@voxelkloud/core";
import type {
  FetchLike,
  FormatProbe,
  LoadSourceOptions,
  OpenPointsOptions,
  PointCloudFormat,
  PointCloudSourceBase,
  PointCloudTreeBase,
  PointReaderFactory,
} from "@voxelkloud/core";
import { ensureDefaultFormats } from "./defaults.js";
import { formats, noFormatMatched } from "./registry.js";

// The global fetch MUST be wrapped, not passed by reference — an unbound
// `fetch` throws "Illegal invocation" in browsers.
const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** How sure a driver must be before the engine stops looking. */
const DECISIVE = 2;
/** Bytes of body kept for magic-number checks. Enough for "LASF" and then some. */
const HEAD_BYTES = 512;
/**
 * Bytes of a candidate document the engine will read before deciding.
 *
 * There IS a cap, and it is not paranoia. Identification fetches whatever a
 * driver names, and for a binary format that document is the cloud itself: a
 * 2 GB COPC was being downloaded in full and text-decoded to look at four bytes
 * of magic. 64 KiB is far above any manifest this project has seen — autzen's
 * `metadata.json` is 3.5 KB and an `ept.json` 1.5 KB — and far below the point
 * where reading it costs anything.
 */
const PROBE_BYTES = 64 * 1024;

export interface LoadPointCloudOptions extends LoadSourceOptions {
  /**
   * Try only this driver, by id. Skips sniffing entirely — use it when the
   * format is known and a wrong guess should be an error rather than a fallback.
   */
  readonly format?: string;
  /**
   * Baseline options for the reader {@link LoadedPointCloud.openPoints}
   * produces — a decompressor, a position format, an attribute selection.
   *
   * Merged UNDER whatever the caller passes at open time, because the renderer
   * decides the attribute selection from its colour mode and must be able to
   * override a default set here.
   */
  readonly points?: OpenPointsOptions;
}

function toAbsolute(input: string | URL): string {
  if (input instanceof URL) return input.href;
  try {
    return new URL(
      input,
      typeof location !== "undefined" ? location.href : undefined,
    ).href;
  } catch (cause) {
    throw new VoxelkloudError(
      "invalid-url",
      `${JSON.stringify(String(input))} is not an absolute http:, https: or ` +
        `file: URL, and there is no document base to resolve it against.`,
      { cause },
    );
  }
}

/**
 * Fetch the front of one candidate document. A 404 is an ANSWER, not a failure.
 *
 * Ranged, and capped at {@link PROBE_BYTES} even when the server ignores the
 * range: the document a driver names may BE the point cloud — COPC identifies
 * itself from the `LASF` at byte 0 of a file that can be gigabytes — and
 * reading all of it to look at four bytes is the difference between a demo that
 * opens and one that hangs.
 *
 * A manifest larger than the cap comes back with `json: undefined`, because a
 * truncated body does not parse. That is the documented cost: the driver
 * fetches it again for itself rather than being handed a lie.
 */
async function probeDocument(
  url: string,
  doFetch: FetchLike,
  options: LoadPointCloudOptions,
): Promise<FormatProbe | undefined> {
  let response: Response;
  try {
    // Merged via `Headers` so the Headers, array and record forms all work.
    const headers = new Headers(options.requestInit?.headers);
    headers.set("Range", `bytes=0-${PROBE_BYTES - 1}`);
    response = await doFetch(url, {
      ...options.requestInit,
      headers,
      signal: options.signal,
    });
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError")
    ) {
      throw cause;
    }
    // A network error against ONE candidate is not fatal while others remain:
    // reporting it as such would turn "this is an EPT cloud" into "the host is
    // down". The final throw carries what was seen.
    return undefined;
  }
  if (!response.ok) return undefined;

  const raw = await readCapped(response);
  const body = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  const text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    url,
    json,
    head: text.slice(0, HEAD_BYTES),
    bytes: raw,
    contentType: response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase(),
  };
}

/**
 * Identify the format at `input` and hand off to its driver.
 *
 * ```ts
 * const source = await loadPointCloudSource("https://cdn.example/autzen/");
 * source.pointCount;        // 10653336
 * source.tightBoundingBox;  // absolute CRS
 * ```
 *
 * The returned source satisfies `PointCloudSourceBase` whichever driver served
 * it; reach for a driver's own fields only when you have decided to be
 * format-specific.
 *
 * HOW IT DECIDES. Drivers are ordered by `sniffUrl`, which is URL shape only
 * and costs nothing. Each candidate then names the document that would identify
 * it — `metadata.json` for Potree, `ept.json` for EPT — and the engine fetches
 * those, ONCE EACH even when several drivers name the same one, until a driver
 * reports decisive confidence. That document is handed to the winning driver so
 * identification does not cost a duplicate round trip.
 *
 * @throws {VoxelkloudError} `"invalid-url"`, `"unsupported-format"`, plus
 *   anything the winning driver throws.
 * @throws The caller-supplied signal's `AbortError`, unwrapped.
 */
export async function loadPointCloudSource(
  input: string | URL,
  options: LoadPointCloudOptions = {},
): Promise<PointCloudSourceBase> {
  const { format, probe } = await identify(input, options);
  return format.load(toAbsolute(input), { ...options, probe });
}

/**
 * Identify, load and open the tree in one call.
 *
 * This is the entry point an application wants: `loadPointCloudSource` gives
 * you a source and then you still need to know which driver produced it to get
 * a tree, which would put the format switch back in the caller that the
 * registry exists to remove.
 *
 * ```ts
 * const { source, tree, openPoints } = await loadPointCloud(url);
 * view.addCloud(source, tree, openPoints);
 * ```
 */
export async function loadPointCloud<
  S extends PointCloudSourceBase = PointCloudSourceBase,
  T extends PointCloudTreeBase = PointCloudTreeBase,
>(
  input: string | URL,
  options: LoadPointCloudOptions = {},
): Promise<LoadedPointCloud<S, T>> {
  const { format, probe } = await identify(input, options);
  const source = await format.load(toAbsolute(input), { ...options, probe });
  const tree = await format.openTree(source, options);
  const openPoints: PointReaderFactory = (open) =>
    format.openPoints(source, { ...options.points, ...open });
  return { format, source: source as S, tree: tree as T, openPoints };
}

/**
 * What {@link loadPointCloud} resolves to.
 *
 * The type parameters let a caller that needs a DRIVER'S OWN fields name them —
 * `loadPointCloud<PotreeSource>(url)`. The engine cannot verify that claim from
 * a URL, so pin the driver with `options.format` when you make it: the pin
 * turns a wrong guess into a thrown `"unsupported-format"` instead of a type
 * that lies. Callers that only need the neutral contract take the defaults and
 * need no pin.
 */
export interface LoadedPointCloud<
  S extends PointCloudSourceBase = PointCloudSourceBase,
  T extends PointCloudTreeBase = PointCloudTreeBase,
> {
  /** The driver that claimed the URL. `format.id` is stable and loggable. */
  readonly format: PointCloudFormat;
  readonly source: S;
  readonly tree: T;
  /**
   * Opens a reader for this cloud's node payloads, already bound to the source
   * and to `options.points`.
   *
   * This is the third thing a renderer needs and the only one that stays
   * format-specific. Handing it back here is what lets
   * `view.addCloud(source, tree, openPoints)` be the whole integration.
   */
  readonly openPoints: PointReaderFactory;
}

async function identify(
  input: string | URL,
  options: LoadPointCloudOptions,
): Promise<{ format: PointCloudFormat; probe: FormatProbe | undefined }> {
  ensureDefaultFormats();
  const url = toAbsolute(input);
  const doFetch = options.fetch ?? defaultFetch;

  if (options.format !== undefined) {
    const only = formats.all().find((f) => f.id === options.format);
    if (only === undefined) {
      throw noFormatMatched(
        url,
        formats.ids,
        `No driver is registered under id ${JSON.stringify(options.format)}.`,
      );
    }
    return { format: only, probe: undefined };
  }

  const candidates = formats.candidates(url);
  if (candidates.length === 0) {
    throw noFormatMatched(
      url,
      formats.ids,
      `No registered driver recognises this URL's shape.`,
    );
  }

  // One fetch per DISTINCT document, not per candidate: two drivers that both
  // identify themselves from `metadata.json` must not cost two round trips.
  const probes = new Map<string, FormatProbe | undefined>();
  let best: { format: PointCloudFormat; probe: FormatProbe; score: number } | undefined;

  for (const format of candidates) {
    const target = format.probeUrl(url);
    if (target === undefined) continue;
    if (!probes.has(target)) {
      probes.set(target, await probeDocument(target, doFetch, options));
    }
    const probe = probes.get(target);
    if (probe === undefined) continue;

    const score = format.sniff(probe);
    if (score <= 0) continue;
    if (best === undefined || score > best.score) best = { format, probe, score };
    // Decisive: no later candidate can do better, and every extra probe is a
    // request against a server that already gave us the answer.
    if (score >= DECISIVE) break;
  }

  if (best === undefined) {
    const seen = [...probes.entries()]
      .map(([u, p]) =>
        p === undefined
          ? `${u} (not reachable)`
          : `${u} (${p.contentType ?? "no content-type"}, starts ${JSON.stringify(p.head.slice(0, 60))})`,
      )
      .join("; ");
    throw noFormatMatched(
      url,
      candidates.map((f) => f.label),
      seen === "" ? "No candidate document was reachable." : `Fetched ${seen}.`,
    );
  }

  return { format: best.format, probe: best.probe };
}

/**
 * Read at most {@link PROBE_BYTES} of a response, then stop.
 *
 * A 206 already gave us that much and no more. A 200 means the server ignored
 * the range — which many static hosts do — and then the cap has to be enforced
 * here, by cancelling the body rather than letting it stream. Without the
 * cancel a host with no range support turns every identification of a large
 * binary format into a full download.
 */
async function readCapped(response: Response): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      parts.push(value);
      total += value.byteLength;
      if (total >= PROBE_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    // A body that fails mid-read still identified whatever arrived before it.
  }

  const buffer = new Uint8Array(Math.min(total, PROBE_BYTES));
  let at = 0;
  for (const part of parts) {
    if (at >= buffer.byteLength) break;
    const slice = part.subarray(0, buffer.byteLength - at);
    buffer.set(slice, at);
    at += slice.byteLength;
  }
  return buffer;
}
