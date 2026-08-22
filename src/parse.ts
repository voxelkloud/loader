import {
  POINT_ATTRIBUTE_TYPE_SIZE,
  UNDECODABLE_ATTRIBUTE_TYPES,
  isPointAttributeTypeName,
} from "@voxelkloud/core";
import type {
  BoundingBox,
  PointCloudMetadata,
  Vec3,
} from "@voxelkloud/core";
import { fail } from "./errors.js";
import type {
  AttributeRole,
  PointAttribute,
  PointCloudSource,
  PointCloudTransportOptions,
  PointCloudUrls,
  PointCloudWarning,
  PointCloudWarningCode,
} from "./types.js";
import {
  deepFreeze,
  describeValue,
  expectArray,
  expectFiniteNumber,
  expectInteger,
  expectNumberArray,
  expectRecord,
  expectString,
  expectVec3,
  optionalString,
} from "./validate.js";

/** Byte size of one hierarchy.bin node record. Task 3 owns the parsing. */
const HIERARCHY_NODE_BYTE_SIZE = 22;

const POSITION_NAMES = new Set(["position", "POSITION_CARTESIAN"]);
const COLOR_NAMES = new Set(["rgb", "rgba", "RGBA"]);
const KNOWN_ENCODINGS = new Set(["DEFAULT", "BROTLI", "UNCOMPRESSED"]);

/** Relative epsilon for the cubic-bounds check — float noise is normal. */
const CUBIC_EPSILON = 1e-6;

/**
 * How far the position bounds may fall outside the octree box before it is
 * worth warning about, as a fraction of the box extent.
 *
 * Deliberately loose. PotreeConverter serialises attribute `min`/`max` with
 * only ~2 decimal places while `boundingBox` keeps full precision, so the
 * rounded attribute bounds routinely escape the box by up to half a unit in
 * the last written decimal. In demo/data/brotli (lion_takanawa) the position
 * min is exactly `boundingBox.min` rounded to 2 decimals — an overshoot of
 * 0.005 on a 5.685 extent, or 0.088% — while autzen's large CRS coordinates
 * hide the same rounding entirely. A tight epsilon here would therefore fire
 * on stock converter output for small-coordinate datasets and not for large
 * ones, which is the worst possible behaviour.
 *
 * This warning exists to catch a box that genuinely does not contain its data
 * — a structural error off by orders of magnitude, not by serialization noise.
 */
const TIGHT_BOUNDS_EPSILON = 1e-2;

const defaultFetch = (input: string, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init);

function roleFor(name: string): AttributeRole | undefined {
  if (POSITION_NAMES.has(name)) return "position";
  if (COLOR_NAMES.has(name)) return "color";
  return undefined;
}

/**
 * Reject inputs that are recognisably some OTHER format before generic shape
 * validation, so a Potree 1.x cloud.js says "this is a Potree 1.x dataset"
 * instead of "attributes: expected array, received undefined".
 */
function sniffForeignFormat(m: Record<string, unknown>): void {
  const isPotree1 =
    "octreeDir" in m ||
    "hierarchyStepSize" in m ||
    typeof m["scale"] === "number" ||
    (typeof m["boundingBox"] === "object" &&
      m["boundingBox"] !== null &&
      "lx" in (m["boundingBox"] as Record<string, unknown>)) ||
    (Array.isArray(m["pointAttributes"]) &&
      m["pointAttributes"].every((a) => typeof a === "string"));
  if (isPotree1) {
    fail(
      "unsupported-format",
      "This looks like a Potree 1.x dataset (cloud.js), which uses a " +
        "different octree layout. Re-run PotreeConverter 2.x to produce " +
        "metadata.json / hierarchy.bin / octree.bin.",
    );
  }

  if (Array.isArray(m["schema"]) && Array.isArray(m["bounds"])) {
    fail(
      "unsupported-format",
      "This looks like an Entwine EPT dataset (ept.json), not a Potree v2 " +
        "metadata.json.",
    );
  }

  const asset = m["asset"];
  if (
    typeof asset === "object" &&
    asset !== null &&
    "version" in (asset as Record<string, unknown>) &&
    typeof m["root"] === "object" &&
    m["root"] !== null
  ) {
    fail(
      "unsupported-format",
      "This looks like a 3D Tiles tileset.json, not a Potree v2 " +
        "metadata.json.",
    );
  }
}

/**
 * Validate an already-parsed `metadata.json` value and derive a
 * {@link PointCloudSource}.
 *
 * Pure and synchronous: no network, no clock, no randomness, no globals beyond
 * `Object`/`Map`. Essentially all of this package's logic lives here, which is
 * what makes the whole validation surface testable against the two fixtures
 * with zero I/O. It is also the entry point for a manifest that arrived by
 * another route — bundled, IndexedDB, a `File` input, `postMessage`.
 *
 * ```ts
 * const urls = resolvePointCloudUrls("https://cdn.example/autzen/");
 * const source = parsePointCloudSource(await res.json(), urls);
 * source.bytesPerPoint;                                  // 35
 * source.attributesByName.get("gps-time")!.byteOffset;   // 21
 * ```
 *
 * @param json Anything. `unknown` is deliberate — proving the value is a Potree
 *   v2 manifest is this function's entire job.
 * @throws {VoxelkloudError} `"unsupported-format"`, `"invalid-metadata"`.
 */
export function parsePointCloudSource(
  json: unknown,
  urls: PointCloudUrls,
  options: PointCloudTransportOptions = {},
): PointCloudSource {
  const warnings: PointCloudWarning[] = [];
  const warn = (
    code: PointCloudWarningCode,
    path: string,
    message: string,
  ): void => {
    warnings.push({ code, path, message });
  };

  const m = expectRecord(json, "");

  sniffForeignFormat(m);

  // ── version ───────────────────────────────────────────────────────────────
  const version = optionalString(m["version"], "version", "");
  const major = Number.parseInt(version, 10);
  if (Number.isFinite(major) && major !== 2) {
    fail(
      "unsupported-format",
      `Unsupported Potree format version ${JSON.stringify(version)}; ` +
        `@voxelkloud/loader reads version 2.x (metadata.json / hierarchy.bin ` +
        `/ octree.bin).`,
      { path: "version" },
    );
  }
  if (version !== "2.0") {
    warn(
      "unexpected-version",
      "version",
      version === ""
        ? "metadata.json has no `version` field; assuming Potree v2.0."
        : `metadata.json declares version ${JSON.stringify(version)}; this ` +
            `loader is written against 2.0. Parsing anyway.`,
    );
  }

  // ── scalars ───────────────────────────────────────────────────────────────
  const name = optionalString(m["name"], "name", "");
  const description = optionalString(m["description"], "description", "");
  const projection = optionalString(m["projection"], "projection", "");

  let points = 0;
  if (m["points"] === undefined) {
    warn(
      "missing-point-count",
      "points",
      "metadata.json has no `points` field; defaulting to 0. Anything that " +
        "derives a count from it will be wrong.",
    );
  } else {
    points = expectInteger(m["points"], "points", { min: 0 });
  }

  const encoding = optionalString(m["encoding"], "encoding", "DEFAULT");
  if (!KNOWN_ENCODINGS.has(encoding)) {
    warn(
      "unknown-encoding",
      "encoding",
      `Unrecognised encoding ${JSON.stringify(encoding)}; treating the ` +
        `octree as uncompressed fixed-stride records. Known values: ` +
        `DEFAULT, UNCOMPRESSED, BROTLI.`,
    );
  }
  const isBrotli = encoding === "BROTLI";

  // ── geometry ──────────────────────────────────────────────────────────────
  const scale = expectVec3(m["scale"], "scale");
  scale.forEach((component, i) => {
    if (component === 0) {
      fail(
        "invalid-metadata",
        `scale[${i}]: a zero scale component collapses every point onto a ` +
          `plane and cannot be recovered from. Expected a non-zero finite ` +
          `number, received 0.`,
        { path: `scale[${i}]` },
      );
    }
  });

  const offset = expectVec3(m["offset"], "offset");
  const spacing = expectFiniteNumber(m["spacing"], "spacing");
  if (spacing <= 0) {
    fail(
      "invalid-metadata",
      `spacing: expected a finite number > 0, received ${describeValue(
        m["spacing"],
      )}`,
      { path: "spacing" },
    );
  }

  const boxRecord = expectRecord(m["boundingBox"], "boundingBox");
  const boundingBox: BoundingBox = Object.freeze({
    min: expectVec3(boxRecord["min"], "boundingBox.min"),
    max: expectVec3(boxRecord["max"], "boundingBox.max"),
  });

  const extents = [0, 1, 2].map((i) => boundingBox.max[i]! - boundingBox.min[i]!);
  const largest = Math.max(...extents);
  if (
    largest > 0 &&
    extents.some((e) => Math.abs(e - largest) / largest > CUBIC_EPSILON)
  ) {
    warn(
      "non-cubic-bounding-box",
      "boundingBox",
      `boundingBox is not cubic (extents ${extents.join(", ")}). Octree ` +
        `subdivision halves each axis independently, so a non-cubic root box ` +
        `desyncs node bounds from the converter's.`,
    );
  }

  // ── hierarchy ─────────────────────────────────────────────────────────────
  const hierarchyRecord = expectRecord(m["hierarchy"], "hierarchy");
  const firstChunkSize = expectInteger(
    hierarchyRecord["firstChunkSize"],
    "hierarchy.firstChunkSize",
    { min: 1 },
  );
  if (firstChunkSize % HIERARCHY_NODE_BYTE_SIZE !== 0) {
    warn(
      "suspicious-first-chunk-size",
      "hierarchy.firstChunkSize",
      `hierarchy.firstChunkSize is ${firstChunkSize}, not a multiple of the ` +
        `${HIERARCHY_NODE_BYTE_SIZE}-byte node record. The first chunk may be ` +
        `truncated.`,
    );
  }
  const stepSize =
    hierarchyRecord["stepSize"] === undefined
      ? undefined
      : expectFiniteNumber(hierarchyRecord["stepSize"], "hierarchy.stepSize");
  const depth =
    hierarchyRecord["depth"] === undefined
      ? undefined
      : expectFiniteNumber(hierarchyRecord["depth"], "hierarchy.depth");

  // ── attributes ────────────────────────────────────────────────────────────
  const rawAttributes = expectArray(m["attributes"], "attributes");
  if (rawAttributes.length === 0) {
    fail(
      "invalid-metadata",
      "attributes: expected a non-empty array. An empty attribute list means " +
        "a zero-byte point record, which makes every downstream offset " +
        "computation degenerate.",
      { path: "attributes" },
    );
  }

  const attributes: PointAttribute[] = [];
  const attributesByName = new Map<string, PointAttribute>();
  let byteOffset = 0;

  rawAttributes.forEach((raw, i) => {
    const at = `attributes[${i}]`;
    const a = expectRecord(raw, at);

    const attrName = expectString(a["name"], `${at}.name`);
    if (attrName === "") {
      fail(
        "invalid-metadata",
        `${at}.name: expected a non-empty string, received the empty string. ` +
          `An attribute's name is its on-disk identity.`,
        { path: `${at}.name` },
      );
    }

    const rawType = a["type"];
    if (!isPointAttributeTypeName(rawType)) {
      fail(
        "invalid-metadata",
        `${at}.type: attribute ${JSON.stringify(attrName)} declares type ` +
          `${describeValue(rawType)}, which is not a known Potree attribute ` +
          `type. Expected one of: ` +
          `${Object.keys(POINT_ATTRIBUTE_TYPE_SIZE).join(", ")}.`,
        { path: `${at}.type` },
      );
    }
    const type = rawType;

    const numElements = expectInteger(a["numElements"], `${at}.numElements`, {
      min: 1,
    });

    const elementSize = POINT_ATTRIBUTE_TYPE_SIZE[type];
    const byteSize = numElements * elementSize;

    // The manifest's own `size`/`elementSize` are cross-checked, then
    // discarded: the canonical table is the authority on stride.
    const declaredElementSize = a["elementSize"];
    const declaredSize = a["size"];
    if (
      (typeof declaredElementSize === "number" &&
        declaredElementSize !== elementSize) ||
      (typeof declaredSize === "number" && declaredSize !== byteSize)
    ) {
      warn(
        "declared-size-mismatch",
        `${at}.size`,
        `Attribute ${JSON.stringify(attrName)} declares size=` +
          `${String(declaredSize)}, elementSize=${String(
            declaredElementSize,
          )}, but type ${type} x ${numElements} elements is ${byteSize} bytes ` +
          `(elementSize ${elementSize}). Using the canonical widths.`,
      );
    }

    const min = expectNumberArray(
      a["min"],
      `${at}.min`,
      numElements,
      `numElements === ${numElements}`,
    );
    const max = expectNumberArray(
      a["max"],
      `${at}.max`,
      numElements,
      `numElements === ${numElements}`,
    );
    if (min.some((v, k) => v > max[k]!)) {
      warn(
        "inverted-range",
        `${at}.min`,
        `Attribute ${JSON.stringify(attrName)} has min > max ` +
          `([${min.join(", ")}] vs [${max.join(", ")}]). Values copied ` +
          `verbatim; anything normalising by this range will be inverted.`,
      );
    }

    const attrScale =
      a["scale"] === undefined
        ? (new Array<number>(numElements).fill(1) as number[])
        : expectNumberArray(
            a["scale"],
            `${at}.scale`,
            numElements,
            `numElements === ${numElements}`,
          );
    const attrOffset =
      a["offset"] === undefined
        ? (new Array<number>(numElements).fill(0) as number[])
        : expectNumberArray(
            a["offset"],
            `${at}.offset`,
            numElements,
            `numElements === ${numElements}`,
          );
    if (attrScale.some((v) => v !== 1) || attrOffset.some((v) => v !== 0)) {
      warn(
        "non-identity-attribute-transform",
        `${at}.scale`,
        `Attribute ${JSON.stringify(attrName)} carries a non-identity ` +
          `per-attribute transform (scale [${attrScale.join(", ")}], offset ` +
          `[${attrOffset.join(", ")}]). No reference Potree client applies ` +
          `these, so values decoded elsewhere may disagree.`,
      );
    }

    let histogram: number[] | undefined;
    if (a["histogram"] !== undefined) {
      // Length is deliberately NOT validated — do not assume 256.
      histogram = expectArray(a["histogram"], `${at}.histogram`).map((v, k) =>
        expectFiniteNumber(v, `${at}.histogram[${k}]`),
      );
    }

    if (UNDECODABLE_ATTRIBUTE_TYPES.has(type)) {
      warn(
        "undecodable-attribute-type",
        `${at}.type`,
        `Attribute ${JSON.stringify(attrName)} has type ${type}, which has no ` +
          `lossless JavaScript representation. The record stride is still ` +
          `correct, but decoding this attribute will fail.`,
      );
    }

    // Wide scalars get packed into float32 downstream; a degenerate range would
    // make `1 / (max - min)` Infinity and every decoded value NaN.
    let normalization: { offset: number; scale: number } | undefined;
    if (numElements === 1 && elementSize > 4) {
      const lo = min[0]!;
      const hi = max[0]!;
      if (lo === hi) {
        warn(
          "degenerate-range",
          `${at}.min`,
          `Attribute ${JSON.stringify(attrName)} has min === max (${lo}), so ` +
            `it cannot be normalised into float32. Using a denominator of 1; ` +
            `every value will decode to 0.`,
        );
      }
      normalization = { offset: lo, scale: 1 / (hi - lo || 1) };
    }

    const attribute: PointAttribute = {
      name: attrName,
      role: roleFor(attrName),
      description: optionalString(a["description"], `${at}.description`, ""),
      type,
      numElements,
      elementSize,
      byteSize,
      byteOffset,
      min,
      max,
      scale: attrScale,
      offset: attrOffset,
      histogram,
      normalization,
    };

    attributes.push(attribute);
    if (attributesByName.has(attrName)) {
      warn(
        "duplicate-attribute-name",
        `${at}.name`,
        `Attribute name ${JSON.stringify(attrName)} appears more than once. ` +
          `Lookups by name resolve to the first occurrence; both records keep ` +
          `their own byte offsets.`,
      );
    } else {
      attributesByName.set(attrName, attribute);
    }

    byteOffset += byteSize;
  });

  const bytesPerPoint = byteOffset;

  // ── tight bounds ──────────────────────────────────────────────────────────
  const position = attributes.find((a) => a.role === "position");
  let tightBoundingBox: BoundingBox;
  if (position === undefined || position.numElements !== 3) {
    warn(
      "missing-position-attribute",
      "attributes",
      "No position attribute (expected one named \"position\" or " +
        "\"POSITION_CARTESIAN\" with 3 elements). Falling back to the cubic " +
        "boundingBox for the tight bounds.",
    );
    tightBoundingBox = boundingBox;
  } else {
    tightBoundingBox = Object.freeze({
      min: Object.freeze([
        position.min[0]!,
        position.min[1]!,
        position.min[2]!,
      ]) as Vec3,
      max: Object.freeze([
        position.max[0]!,
        position.max[1]!,
        position.max[2]!,
      ]) as Vec3,
    });
    const escapes = [0, 1, 2].some((i) => {
      const extent = boundingBox.max[i]! - boundingBox.min[i]!;
      const slack = Math.abs(extent) * TIGHT_BOUNDS_EPSILON;
      return (
        tightBoundingBox.min[i]! < boundingBox.min[i]! - slack ||
        tightBoundingBox.max[i]! > boundingBox.max[i]! + slack
      );
    });
    if (escapes) {
      warn(
        "tight-bounds-outside-bounding-box",
        "attributes",
        `The position attribute's bounds ([${tightBoundingBox.min.join(
          ", ",
        )}] .. [${tightBoundingBox.max.join(", ")}]) fall outside the octree ` +
          `boundingBox. Points may be culled or mis-assigned to nodes.`,
      );
    }
  }

  const metadata: PointCloudMetadata = {
    version,
    name,
    description,
    points,
    projection,
    hierarchy: { firstChunkSize, stepSize, depth },
    offset,
    scale,
    spacing,
    boundingBox,
    encoding,
  };

  const source: PointCloudSource = {
    metadata,
    urls,
    attributes,
    attributesByName,
    bytesPerPoint,
    isBrotli,
    tightBoundingBox,
    warnings,
    transport: {
      fetch: options.fetch ?? defaultFetch,
      requestInit: options.requestInit,
    },
  };

  // `attributesByName` is readonly by type only — a Map's contents cannot be
  // frozen. Everything reachable by property is frozen.
  deepFreeze(metadata);
  deepFreeze(attributes);
  deepFreeze(tightBoundingBox);
  deepFreeze(warnings);
  Object.freeze(source.transport);
  Object.freeze(source);

  return source;
}
