import type { BoundingBox } from "@voxelkloud/core";
import { VoxelkloudError, isVoxelkloudError } from "./errors.js";
import {
  PrefetchTooLarge,
  fetchChunk,
  fetchWholeHierarchy,
  isAbort,
} from "./hierarchy-fetch.js";
import type { ChunkResult } from "./hierarchy-fetch.js";
import { Node, makeRootNode, rootHalfDiagonal } from "./hierarchy-node.js";
import type { ParseContext, Scratch } from "./hierarchy-parse.js";
import { parseChunkInto } from "./hierarchy-parse.js";
import type {
  CreateHierarchyOptions,
  ExpandOptions,
  HierarchyChunkRef,
  HierarchyNode,
  HierarchyNodeState,
  HierarchyOptions,
  HierarchyStats,
  LoadHierarchyOptions,
  PointCloudHierarchy,
} from "./hierarchy-types.js";
import type {
  PointCloudSource,
  PointCloudWarning,
  PointCloudWarningCode,
} from "./types.js";

const DEFAULT_MAX_PREFETCH_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 8_000_000;
const DEFAULT_MAX_ATTEMPTS = 3;

const defaultRetryDelayMs = (attempt: number): number =>
  Math.min(250 * 2 ** (attempt - 1), 10_000);

/** HTTP statuses that will never succeed on a retry. */
const DETERMINISTIC_STATUS = new Set([400, 401, 403, 404, 405, 410, 416]);

interface InFlight {
  readonly controller: AbortController;
  readonly promise: Promise<ChunkResult>;
  refs: number;
  /** Set while the entry is still queued behind the concurrency cap. */
  queued: boolean;
  start?: () => void;
}

/** Compose two signals, preferring the platform implementation when present. */
function anySignal(
  a: AbortSignal,
  b: AbortSignal | undefined,
): AbortSignal {
  if (b === undefined) return a;
  const AnyFn = (
    AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof AnyFn === "function") return AnyFn([a, b]);
  const controller = new AbortController();
  const onAbort = (signal: AbortSignal) => () => controller.abort(signal.reason);
  if (a.aborted) controller.abort(a.reason);
  else if (b.aborted) controller.abort(b.reason);
  else {
    a.addEventListener("abort", onAbort(a), { once: true });
    b.addEventListener("abort", onAbort(b), { once: true });
  }
  return controller.signal;
}

/**
 * Read a node's state without letting TypeScript narrow the property.
 *
 * `tryExpandSync` and the awaited chunk parse both mutate `node.state` through
 * an alias, which control-flow analysis cannot see — so a direct
 * `node.state === "failed"` after such a call is reported as a non-overlapping
 * comparison against a stale narrowed type.
 */
function stateOf(node: Node): HierarchyNodeState {
  return node.state;
}

class Hierarchy implements PointCloudHierarchy, ParseContext {
  readonly source: PointCloudSource;
  readonly root: Node;
  readonly nodeList: Node[];
  readonly visitedChunks = new Set<number>();
  readonly warnings: PointCloudWarning[] = [];

  knownPoints = 0;
  maxLevel = 0;
  chunksParsed = 0;
  scratch: Scratch | undefined = undefined;

  readonly maxNodes: number;
  readonly maxDepth: number;
  private readonly maxPrefetchBytes: number;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly now: () => number;

  private buffer: ArrayBuffer | undefined = undefined;
  private bufferView: DataView | undefined = undefined;
  private complete = false;
  private totalLength: number | undefined = undefined;

  private requests = 0;
  private bytesFetched = 0;

  private readonly inFlight = new Map<number, InFlight>();
  private readonly queue: InFlight[] = [];
  private active = 0;
  private readonly emitted = new Set<PointCloudWarningCode>();
  private disposed = false;

  constructor(source: PointCloudSource, options: CreateHierarchyOptions = {}) {
    this.source = source;
    this.root = makeRootNode(source);
    this.nodeList = [this.root];
    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxPrefetchBytes = options.maxPrefetchBytes ?? DEFAULT_MAX_PREFETCH_BYTES;
    this.maxConcurrent =
      options.maxConcurrentChunkRequests ?? DEFAULT_MAX_CONCURRENT;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
    this.now = options.now ?? Date.now;

    if (options.buffer !== undefined) {
      const b = options.buffer;
      const ab =
        b instanceof ArrayBuffer
          ? b
          : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      this.adoptBuffer(ab, true);
    }
  }

  // ── synchronous view ────────────────────────────────────────────────────

  get nodeCount(): number {
    return this.nodeList.length;
  }
  get byteLength(): number | undefined {
    return this.totalLength;
  }
  get resident(): boolean {
    return this.complete;
  }
  get pendingCount(): number {
    return this.inFlight.size;
  }
  get stats(): HierarchyStats {
    return {
      requests: this.requests,
      bytesFetched: this.bytesFetched,
      chunksParsed: this.chunksParsed,
    };
  }

  node(index: number): HierarchyNode | undefined {
    return this.nodeList[index];
  }

  nodeByName(name: string): HierarchyNode | undefined {
    if (name.charCodeAt(0) !== 114 /* r */) return undefined;
    let node: HierarchyNode | undefined = this.root;
    for (let i = 1; i < name.length; i++) {
      const c = name.charCodeAt(i) - 48;
      if (c < 0 || c > 7) return undefined;
      node = node.children[c];
      if (node === undefined) return undefined;
    }
    return node;
  }

  *nodes(): IterableIterator<HierarchyNode> {
    for (const n of this.nodeList) yield n;
  }

  spacingAt(level: number): number {
    return this.source.metadata.spacing / 2 ** level;
  }

  radiusAt(level: number): number {
    return rootHalfDiagonal(this.root) / 2 ** level;
  }

  boundingBoxOf(node: HierarchyNode): BoundingBox {
    return {
      min: [node.minX, node.minY, node.minZ],
      max: [node.maxX, node.maxY, node.maxZ],
    };
  }

  warn(code: PointCloudWarningCode, path: string, message: string): void {
    // At most once per code: `warnings` is append-only over the tree's whole
    // life, so a corrupt file with 400k bad nodes would otherwise allocate 400k
    // warning objects. A warning is a signal, not an inventory.
    if (this.emitted.has(code)) return;
    this.emitted.add(code);
    this.warnings.push({ code, path, message });
  }

  // ── expansion ───────────────────────────────────────────────────────────

  private adoptBuffer(buffer: ArrayBuffer, complete: boolean): void {
    this.buffer = buffer;
    this.bufferView = new DataView(buffer);
    this.totalLength = buffer.byteLength;
    if (complete) this.complete = true;
  }

  private chunkResident(ref: HierarchyChunkRef): boolean {
    return (
      this.buffer !== undefined &&
      ref.byteOffset >= 0 &&
      ref.byteOffset + ref.byteSize <= this.buffer.byteLength
    );
  }

  private expandable(node: HierarchyNode): node is Node {
    return (
      node instanceof Node &&
      this.nodeList[node.index] === node &&
      node.chunk !== undefined
    );
  }

  private recordFailure(node: Node, error: unknown, permanent: boolean): void {
    const err = isVoxelkloudError(error)
      ? error
      : new VoxelkloudError("hierarchy-error", String(error), { cause: error });
    node.attempts++;
    const attempts = node.attempts;
    const exhausted = permanent || attempts >= this.maxAttempts;
    node.state = "failed";
    node.failure = {
      error: err,
      attempts,
      retryAfter: exhausted ? undefined : this.now() + this.retryDelayMs(attempts),
    };
  }

  private retryDue(node: Node): boolean {
    const f = node.failure;
    if (f === undefined) return true;
    if (f.retryAfter === undefined) return false;
    return this.now() >= f.retryAfter;
  }

  tryExpandSync(node: HierarchyNode): boolean {
    if (node.state === "expanded") return true;
    if (node.state !== "unexpanded") return false;
    if (!this.expandable(node)) return false;
    if (this.bufferView === undefined) return false;
    const chunk = node.chunk!;
    if (!this.chunkResident(chunk)) {
      // With the WHOLE file resident, a chunk pointer that lands outside it is
      // corruption, not "not fetched yet" — and the two are otherwise
      // indistinguishable from the caller's side, so a bad pointer would
      // silently look like a permanently un-expandable subtree.
      if (this.complete) {
        this.recordFailure(
          node,
          new VoxelkloudError(
            "hierarchy-error",
            `${node.name}: chunk [${chunk.byteOffset}, ` +
              `${chunk.byteOffset + chunk.byteSize}) falls outside ` +
              `hierarchy.bin (${this.buffer?.byteLength ?? 0} bytes).`,
            { path: node.name },
          ),
          true,
        );
      }
      return false;
    }
    // Clear any stale failure before the node can reach "expanded" and freeze;
    // `node.attempts` survives so an exhausted budget stays exhausted.
    node.failure = undefined;
    try {
      parseChunkInto(this, node, this.bufferView, chunk.byteOffset, chunk.byteSize);
    } catch (err) {
      // A malformed chunk is a permanent node failure, exactly as on the async
      // path — so this stays safe to call from a render loop.
      this.recordFailure(node, err, true);
      return false;
    }
    return true;
  }

  async expand(
    node: HierarchyNode,
    options: ExpandOptions = {},
  ): Promise<HierarchyNode> {
    if (node.state === "expanded") return node;

    if (!this.expandable(node)) {
      throw new VoxelkloudError(
        "hierarchy-error",
        `Node ${node.name} does not belong to this hierarchy, or has no chunk ` +
          `of its own to expand.`,
        { path: node.name },
      );
    }

    if (node.state === "failed") {
      if (!this.retryDue(node)) throw node.failure!.error;
      node.state = "unexpanded";
    }

    if (this.tryExpandSync(node)) return node;
    if (stateOf(node) === "failed") throw node.failure!.error;

    const chunk = node.chunk!;
    const key = chunk.byteOffset;
    let entry = this.inFlight.get(key);

    if (entry === undefined) {
      entry = this.createInFlight(node, chunk);
      this.inFlight.set(key, entry);
    } else {
      entry.refs++;
    }
    node.state = "expanding";

    const signal = options.signal;
    try {
      const result = await this.race(entry.promise, signal);
      // Only the first caller to arrive parses; later ones find it expanded.
      if (stateOf(node) !== "expanded") {
        if (result.wholeFile) {
          this.adoptBuffer(result.buffer, true);
          this.warn(
            "range-requests-ignored",
            this.source.urls.hierarchy,
            `${this.source.urls.hierarchy} answered 200 to a Range request ` +
              `and returned the whole file. It has been adopted into memory, ` +
              `so the rest of the hierarchy is served without further ` +
              `requests, but this host does not honour Range.`,
          );
        }
        // A lone chunk is NEVER adopted as the resident buffer: it holds one
        // chunk's bytes at offset 0, so keeping it would make `chunkResident`
        // lie about every other chunk and would report its length as the
        // file's. It is parsed from its own view and discarded.
        if (result.totalLength !== undefined && this.totalLength === undefined) {
          this.totalLength = result.totalLength;
        }
        const view = result.wholeFile
          ? this.bufferView!
          : new DataView(result.buffer);
        const start = result.wholeFile ? chunk.byteOffset : 0;
        node.failure = undefined;
        try {
          parseChunkInto(this, node, view, start, chunk.byteSize);
        } catch (err) {
          this.recordFailure(node, err, true);
          throw node.failure!.error;
        }
      }
      return node;
    } catch (err) {
      if (isAbort(err)) {
        // An abort is a caller-side decision carrying zero information about
        // the resource: RELEASE, do not poison. A fast camera pan that
        // poisoned chunks would permanently blind subtrees.
        if (stateOf(node) === "expanding") node.state = "unexpanded";
        throw err;
      }
      if (stateOf(node) !== "failed") {
        this.recordFailure(node, err, this.isDeterministic(err));
      }
      throw node.failure?.error ?? err;
    } finally {
      entry.refs--;
      if (entry.refs <= 0) {
        this.inFlight.delete(key);
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        entry.controller.abort();
      }
    }
  }

  private isDeterministic(err: unknown): boolean {
    if (!isVoxelkloudError(err)) return false;
    if (err.code === "hierarchy-error") return true;
    if (err.code === "range-request-unsupported") return true;
    if (err.status !== undefined && DETERMINISTIC_STATUS.has(err.status)) {
      return true;
    }
    return false;
  }

  /** Race the shared chunk promise against this caller's own signal. */
  private race<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return p;
    if (signal.aborted) {
      return Promise.reject(
        new DOMException("The operation was aborted.", "AbortError"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  private createInFlight(node: Node, chunk: HierarchyChunkRef): InFlight {
    const controller = new AbortController();
    let start!: () => void;
    const gate = new Promise<void>((resolve) => {
      start = resolve;
    });

    const promise = gate.then(() =>
      fetchChunk(
        this.source,
        chunk.byteOffset,
        chunk.byteSize,
        this.maxPrefetchBytes,
        anySignal(controller.signal, undefined),
        (n) => {
          this.bytesFetched += n;
        },
      ).finally(() => {
        this.active--;
        this.pump();
      }),
    );

    const entry: InFlight = { controller, promise, refs: 1, queued: true, start };
    // A rejection with zero current awaiters must never surface as an unhandled
    // rejection.
    promise.catch(() => {});
    this.queue.push(entry);
    this.pump();
    return entry;
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      // A queued entry whose refs dropped to 0 never issues a request.
      if (entry.refs <= 0) continue;
      entry.queued = false;
      this.active++;
      this.requests++;
      entry.start?.();
    }
  }

  requestExpand(node: HierarchyNode, signal?: AbortSignal): void {
    if (node.state === "expanded" || node.state === "expanding") return;
    if (node.state === "failed" && !(node instanceof Node && this.retryDue(node))) {
      return;
    }
    if (this.tryExpandSync(node)) return;
    // Nothing is swallowed: a failure lands on node.state/node.failure, which
    // the caller reads on its next frame.
    void this.expand(node, signal === undefined ? {} : { signal }).catch(() => {});
  }

  async expandAll(options: ExpandOptions = {}): Promise<void> {
    for (;;) {
      const pending: Node[] = [];
      for (const n of this.nodeList) {
        if (n.state === "unexpanded" && n.chunk !== undefined) pending.push(n);
      }
      if (pending.length === 0) break;

      // Drain everything already resident first — 0 requests under the default
      // policy.
      let progressed = false;
      const remaining: Node[] = [];
      for (const n of pending) {
        if (this.tryExpandSync(n)) progressed = true;
        else if (n.state === "unexpanded") remaining.push(n);
      }

      if (remaining.length > 0) {
        for (let i = 0; i < remaining.length; i += this.maxConcurrent) {
          const batch = remaining.slice(i, i + this.maxConcurrent);
          // Fail-fast per Task 2; the partially-expanded tree stays valid.
          await Promise.all(batch.map((n) => this.expand(n, options)));
          progressed = true;
        }
      }

      if (!progressed) break;
    }

    const declared = this.source.metadata.points;
    if (declared > 0 && this.knownPoints !== declared) {
      this.warn(
        "point-count-mismatch",
        "points",
        `The hierarchy accounts for ${this.knownPoints} points but ` +
          `metadata.json declares ${declared}. This poisons the LOD budget ` +
          `and can indicate a misaligned parse.`,
      );
    }
  }

  retry(node: HierarchyNode): void {
    if (!(node instanceof Node)) return;
    if (node.state !== "failed") return;
    node.failure = undefined;
    node.attempts = 0;
    node.state = "unexpanded";
  }

  dispose(reason?: unknown): void {
    this.disposed = true;
    for (const entry of this.inFlight.values()) entry.controller.abort(reason);
    this.inFlight.clear();
    this.queue.length = 0;
    this.active = 0;
    for (const n of this.nodeList) {
      if (n.state === "expanding") n.state = "unexpanded";
    }
  }

  /** Only used by loadHierarchy. */
  async prefetch(
    mode: "auto" | "always",
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const cap = mode === "always" ? Infinity : this.maxPrefetchBytes;
    this.requests++;
    try {
      const { buffer } = await fetchWholeHierarchy(this.source, cap, signal, (n) => {
        this.bytesFetched += n;
      });
      this.adoptBuffer(buffer, true);
    } catch (err) {
      if (isAbort(err)) throw err;
      if (mode === "always") throw err;
      const measured =
        err instanceof PrefetchTooLarge && err.measured !== undefined
          ? `${err.measured} bytes`
          : "an unknown size";
      this.warn(
        "hierarchy-prefetch-skipped",
        this.source.urls.hierarchy,
        `Could not buffer ${this.source.urls.hierarchy} whole (${measured}, ` +
          `maxPrefetchBytes is ${this.maxPrefetchBytes}); falling back to one ` +
          `Range request per hierarchy chunk.` +
          (isVoxelkloudError(err) ? ` Cause: ${err.message}` : ""),
      );
    }
  }
}

/**
 * Build a hierarchy with no I/O.
 *
 * With `options.buffer` set to the whole of hierarchy.bin, the returned tree
 * never performs a request: `tryExpandSync` always succeeds. This is the pure,
 * synchronous entry point the test suite exercises, mirroring Task 2's
 * `parsePointCloudSource`.
 */
export function createHierarchy(
  source: PointCloudSource,
  options: CreateHierarchyOptions = {},
): PointCloudHierarchy {
  return new Hierarchy(source, options) as unknown as PointCloudHierarchy;
}

/**
 * Fetch hierarchy.bin and expand the root.
 *
 * Under the default `prefetch: "auto"` policy this issues exactly ONE request —
 * a plain unranged GET of the whole file — and every later expansion is a
 * synchronous slice out of the resident buffer, so descending past a chunk
 * boundary costs zero frames of latency. See {@link HierarchyOptions.prefetch}
 * for the measured reasoning and the fallbacks.
 *
 * ```ts
 * const source = await loadPointCloudSource("https://cdn.example/autzen/");
 * const tree = await loadHierarchy(source);
 * tree.root.childMask;   // 255
 * tree.nodeCount;        // 257 after the root chunk
 * ```
 */
export async function loadHierarchy(
  source: PointCloudSource,
  options: LoadHierarchyOptions = {},
): Promise<PointCloudHierarchy> {
  const h = new Hierarchy(source, options);
  const mode = options.prefetch ?? "auto";
  if (mode !== "never") {
    await h.prefetch(mode, options.signal);
  }
  await h.expand(
    h.root,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return h as unknown as PointCloudHierarchy;
}
