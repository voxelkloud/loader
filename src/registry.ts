import { VoxelkloudError } from "@voxelkloud/core";
import type {
  FormatProbe,
  LoadSourceOptions,
  PointCloudFormat,
  PointCloudSourceBase,
} from "@voxelkloud/core";

/**
 * The set of drivers this engine will try.
 *
 * A MUTABLE registry rather than a static list, because the drivers are
 * separate packages: an app that only ever reads Potree should not pull a LAZ
 * decoder into its bundle to find that out. `@voxelkloud/loader` registers
 * Potree v2 by default — it is the format this project started with and
 * zero-config must keep working — and anything else is one `register` call.
 */
export class FormatRegistry {
  private readonly formats: PointCloudFormat[] = [];

  register(format: PointCloudFormat<never>): this;
  register(format: PointCloudFormat<PointCloudSourceBase>): this;
  register(format: PointCloudFormat<never> | PointCloudFormat): this {
    const f = format as PointCloudFormat;
    // Re-registering an id REPLACES rather than appends. Registration commonly
    // runs at module scope, and a bundler that includes a module twice would
    // otherwise leave two identical candidates competing on equal confidence.
    const at = this.formats.findIndex((x) => x.id === f.id);
    if (at >= 0) this.formats[at] = f;
    else this.formats.push(f);
    return this;
  }

  unregister(id: string): boolean {
    const at = this.formats.findIndex((x) => x.id === id);
    if (at < 0) return false;
    this.formats.splice(at, 1);
    return true;
  }

  get ids(): readonly string[] {
    return this.formats.map((f) => f.id);
  }

  /** Candidates in descending URL-shape confidence. Zero-confidence dropped. */
  candidates(url: string): readonly PointCloudFormat[] {
    return this.formats
      .map((f) => ({ f, score: f.sniffUrl(url) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((c) => c.f);
  }

  /** Every registered driver, in registration order. */
  all(): readonly PointCloudFormat[] {
    return this.formats;
  }
}

/** The registry `loadPointCloudSource` consults. */
export const formats = new FormatRegistry();

export type { FormatProbe, LoadSourceOptions, PointCloudFormat };

export function noFormatMatched(
  url: string,
  tried: readonly string[],
  detail: string,
): VoxelkloudError {
  return new VoxelkloudError(
    "unsupported-format",
    `Nothing at ${url} matched a registered point cloud format. ` +
      `Tried: ${tried.length > 0 ? tried.join(", ") : "(no drivers registered)"}. ` +
      detail +
      ` @voxelkloud/loader registers Potree v2 only; the other drivers are ` +
      `separate packages so an app that reads one format does not bundle the ` +
      `others' codecs. Register one with \`formats.register(copcFormat)\` from ` +
      `@voxelkloud/format-copc, or \`formats.register(eptFormat)\` from ` +
      `@voxelkloud/format-ept.`,
    { url },
  );
}
