import type { BoundingBox, ChildIndex } from "@voxelkloud/core";
import type { VoxelkloudError } from "./errors.js";
import type { PointCloudSource, PointCloudWarning } from "./types.js";

/**
 * Where a node is in the EXPANSION lifecycle. Deliberately about CHILDREN, not
 * about points — there is no `loaded` here, because point geometry is Task 4's
 * and lives nowhere on this object. A node can be `"expanded"` with no points
 * ever fetched, forever.
 *
 * - `"unexpanded"` — children UNKNOWN. Either the root before its first chunk,
 *   or a node named by a Proxy record in its parent's chunk. `numPoints` and
 *   `chunk` are known; `childMask`, `byteOffset` and `byteSize` are not.
 * - `"expanding"` — a chunk request is in flight. Children still unknown.
 * - `"expanded"` — children known and FINAL (possibly zero of them). Every node
 *   whose record was inlined in its parent's chunk is born in this state.
 *   Terminal in Task 3, and the state in which the node is frozen.
 * - `"failed"` — the last expansion attempt failed; see `failure`. Task 6 must
 *   treat this as "cull this subtree", not "retry".
 */
export type HierarchyNodeState =
  | "unexpanded"
  | "expanding"
  | "expanded"
  | "failed";

/**
 * A byte range inside hierarchy.bin. NEVER inside octree.bin — a deliberately
 * separate field pair from {@link HierarchyNode.byteOffset}/`byteSize`, because
 * the reference stores both meanings in the same two fields, where `byteOffset`
 * means two different things depending on unobservable state.
 */
export interface HierarchyChunkRef {
  readonly byteOffset: number;
  readonly byteSize: number;
}

export interface HierarchyFailure {
  readonly error: VoxelkloudError;
  /** Attempts made so far, including the one that produced `error`. */
  readonly attempts: number;
  /**
   * `Date.now()`-style timestamp after which this node becomes eligible again.
   *
   * `undefined` means PERMANENT — a 404/403/410/416, any `"hierarchy-error"`,
   * any `"range-request-unsupported"`, or a transient failure that exhausted
   * `maxAttempts`. Retrying a deterministic failure is precisely what produces
   * the reference's per-frame request storm, so it never happens implicitly;
   * {@link PointCloudHierarchy.retry} is the only escape.
   */
  readonly retryAfter: number | undefined;
}

/**
 * Fixed length 8, indexed by octant. A slot holds `undefined` when there is no
 * child in that octant — a meaning that is only valid once
 * `state === "expanded"`; while unexpanded EVERY slot is `undefined` and that
 * means "unknown", which is why {@link HierarchyNode.childMask} is the field
 * you check, not this one.
 *
 * A plain indexable tuple, never an allocating `getChildren()`. Indexing it
 * with a plain `number` is safe under `noUncheckedIndexedAccess` because the
 * element type already includes `undefined`, so a `for (let c = 0; c < 8; c++)`
 * loop needs no cast and no `!`.
 *
 * Childless nodes — 3525 of autzen's 4377, 80.5% — all share ONE frozen
 * all-`undefined` instance.
 */
export type HierarchyChildren = readonly [
  HierarchyNode | undefined,
  HierarchyNode | undefined,
  HierarchyNode | undefined,
  HierarchyNode | undefined,
  HierarchyNode | undefined,
  HierarchyNode | undefined,
  HierarchyNode | undefined,
  HierarchyNode | undefined,
];

/**
 * One octree node.
 *
 * Created exactly once, when the record that names it is read, and thereafter
 * IDENTITY-STABLE for the tree's lifetime. Expansion mutates the object in
 * place and never replaces it — a scheduler holds node references across
 * frames, and swapping `parent.children[i]` for a different object makes
 * `children[i]` polymorphic and every downstream property access megamorphic.
 *
 * FROZEN exactly when `state === "expanded"`. The invariant
 * `Object.isFrozen(node) === (node.state === "expanded")` holds for every node
 * at every instant and is asserted by the test suite.
 *
 * There is deliberately NO `loaded`, `loading`, `geometry`, `density`, `id`,
 * `hasChildren`, `spacing`, `boundingSphere` or `nodeType` field. Per-frame and
 * per-load state lives in index-parallel typed arrays owned by Tasks 4/6/7 —
 * measured 2.2 ns/read against 23-38 ns for a Map keyed by the node.
 */
export interface HierarchyNode {
  /**
   * Dense, 0-based, STABLE and NEVER REUSED. `hierarchy.node(i).index === i`.
   * This is the key Tasks 4, 6 and 7 build their parallel arrays on.
   *
   * Two ordering guarantees, both free and both load-bearing downstream:
   * - `parent.index < node.index` for every non-root node.
   * - a node's children occupy a CONTIGUOUS ascending index run, because
   *   children of one node are always created in a single burst during the
   *   parse of the one chunk that holds that node's record.
   *
   * Together these let Task 7 sort a visibility set on an integer key and let
   * Task 4 coalesce a sibling group into one Range request.
   */
  readonly index: number;

  /**
   * `"r"`, `"r0"`, `"r0402"`. The stable on-disk identity and the right cache
   * key. NOT the way to find a parent or a child slot — use `parent` and
   * `childIndex`, which exist precisely so a renderer never does
   * `parseInt(name.slice(-1))` plus a name-keyed Map every frame.
   */
  readonly name: string;

  /** Root is 0. Equals `name.length - 1`. */
  readonly level: number;

  /**
   * This node's octant in its parent. `0` for the root (whose `parent` is
   * `undefined`, so the value is meaningless there). Stored explicitly, never
   * recovered from the last character of `name` — which yields `NaN` for the
   * root.
   */
  readonly childIndex: ChildIndex;

  /** `undefined` only for the root. */
  readonly parent: HierarchyNode | undefined;

  readonly children: HierarchyChildren;

  /**
   * Octant occupancy bitfield: bit c set means `children[c] !== undefined`.
   * `undefined` means UNKNOWN, never zero.
   *
   * This — not the record's `type` byte, which is not exposed — is the only
   * has-children signal. A Proxy record's childMask byte on disk is ALWAYS 0
   * (verified 191/191 on autzen) and always disagrees with the node's true mask
   * found at record 0 of its own chunk. Typing this `number | undefined` is the
   * single change that makes that lie unrepresentable, and is why there is no
   * `hasChildren` field.
   *
   * `childMask === 0` is the LOD loop's cheap leaf early-out.
   */
  readonly childMask: number | undefined;

  /**
   * Points stored at THIS node only — never a subtree total. Inner nodes hold a
   * subsampled layer that is not duplicated in descendants, so summing over the
   * whole tree yields `metadata.points` EXACTLY (verified: 10,653,336 / 341,989
   * / 17,500, delta 0 on all three fixtures). A caller who assumes cumulative
   * counts under-refines by roughly 2x.
   *
   * ALWAYS KNOWN, including while `"unexpanded"`: a Proxy record carries
   * `numPoints` even though it carries no octree pointer. That is what lets the
   * LOD budget cover the entire top of the tree after one request.
   *
   * ONE exception: the ROOT is 0 until its own chunk is parsed, because no
   * record names the root before then. `loadHierarchy` always expands the root
   * before it resolves, so a caller only sees this via `createHierarchy`.
   *
   * Already normalised for potree/potree#1125: a record with `byteSize === 0`
   * has this forced to 0, with a `zero-byte-node` warning if it claimed more.
   */
  readonly numPoints: number;

  /**
   * Byte range into `source.urls.octree`. Task 4's only input. `undefined`
   * while `"unexpanded"` — a proxy has no octree location anywhere in
   * hierarchy.bin until record 0 of its own chunk arrives, because its
   * parent-chunk record spent those two fields on the chunk pointer.
   *
   * `byteSize === 0` is legal and common (47 nodes on autzen). Task 4 MUST skip
   * the request entirely rather than emitting `bytes=X-(X-1)`, which RFC 9110
   * says an origin IGNORES — answering 200 with the entire octree.bin. Use
   * `node.byteSize === 0` as the predicate; `byteOffset === 0` is NOT a
   * sentinel (autzen's r40600 legitimately owns `[0, 132405)`).
   */
  readonly byteOffset: number | undefined;
  readonly byteSize: number | undefined;

  /**
   * Axis-aligned bounds, as SIX FLAT SCALARS rather than `{min:[…],max:[…]}`.
   * One dereference instead of three on the LOD loop's hottest read, and one
   * object per node instead of three. Use
   * {@link PointCloudHierarchy.boundingBoxOf} when you want a `BoundingBox` and
   * are not in a per-frame loop.
   *
   * ABSOLUTE CRS UNITS — the same frame as `source.metadata.boundingBox` and
   * `source.tightBoundingBox`. DELIBERATE DIVERGENCE from the reference, which
   * translates every node box by `-boundingBox.min`, leaving node boxes in a
   * local frame while Task 2's `tightBoundingBox` is absolute. Mixing the two
   * is a silent geometry bug, so we pick one. A renderer that wants an
   * origin-local frame subtracts `metadata.boundingBox.min` once, in its own
   * matrix.
   */
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;

  /**
   * Where this node's OWN chunk of hierarchy.bin lives, or `undefined` if its
   * record was inlined in its parent's chunk. Defined for the root and for
   * every node that was ever a proxy — 192 of autzen's 4377.
   *
   * RETAINED AFTER EXPANSION, deliberately: 16 bytes per proxy is the entire
   * difference between "a future task can collapse a cold subtree back to a
   * stub and re-fetch it" and "the node graph grows monotonically for the
   * viewer's lifetime".
   */
  readonly chunk: HierarchyChunkRef | undefined;

  readonly state: HierarchyNodeState;

  /** Set iff `state === "failed"`. Cleared by `retry` or a later success. */
  readonly failure: HierarchyFailure | undefined;
}

export interface HierarchyStats {
  /** HTTP requests issued for hierarchy.bin. 1 under the default policy. */
  readonly requests: number;
  /** Body bytes read, decoded. */
  readonly bytesFetched: number;
  /** Chunks successfully parsed and spliced. 192 for a fully expanded autzen. */
  readonly chunksParsed: number;
}

/**
 * A live, partially-resident octree node graph.
 *
 * Two layers that never mix. The SYNCHRONOUS layer — `root`, `node()`,
 * `nodeByName()`, every field on a `HierarchyNode`, `radiusAt`, `spacingAt`,
 * `tryExpandSync` — never awaits, never allocates on the hot path, and is what
 * a per-frame LOD walk uses exclusively. The ASYNC layer — `expand`,
 * `requestExpand`, `expandAll` — is fallible, cancellable and deduped.
 *
 * NOT frozen as a whole and NOT structured-cloneable: `parent` back-pointers
 * make the graph cyclic. That is deliberate and costs nothing — Task 4's decode
 * worker never needs the tree. Individual nodes ARE frozen once expanded.
 */
export interface PointCloudHierarchy {
  /** The Task 2 source. Every request goes through `source.transport`. */
  readonly source: PointCloudSource;
  /** Always present. `"expanded"` on return from `loadHierarchy`. */
  readonly root: HierarchyNode;

  /**
   * Nodes materialised so far. MONOTONIC — grows as chunks arrive, never
   * shrinks, and is the exact upper bound on `node.index`. Tasks 4/6/7 size
   * their parallel arrays from this and grow when it changes.
   */
  readonly nodeCount: number;
  /**
   * Sum of `numPoints` over materialised nodes. Equals `metadata.points`
   * exactly once fully expanded (verified on all three fixtures).
   */
  readonly knownPoints: number;
  /** Highest `level` materialised so far. */
  readonly maxLevel: number;

  /**
   * Total length of hierarchy.bin, when known — from a whole-file fetch or an
   * opportunistically-read `Content-Range`. `undefined` in per-chunk mode
   * against a cross-origin server that does not expose `Content-Range` (that
   * header is NOT CORS-safelisted). Its absence is normal and never warned
   * about.
   */
  readonly byteLength: number | undefined;
  /**
   * `true` when the whole of hierarchy.bin is in memory, i.e. `tryExpandSync`
   * will succeed for every expandable node.
   */
  readonly resident: boolean;
  /** Chunk requests in flight. */
  readonly pendingCount: number;

  /**
   * Tolerated anomalies, in discovery order. APPEND-ONLY, and it GROWS over the
   * tree's life — unlike `source.warnings`, which is complete at parse time.
   * Each code is emitted AT MOST ONCE per hierarchy, so this array is bounded
   * even on a hostile file.
   */
  readonly warnings: readonly PointCloudWarning[];
  readonly stats: HierarchyStats;

  /** O(1). `undefined` for `index >= nodeCount`. */
  node(index: number): HierarchyNode | undefined;
  /**
   * Resolve `"r047"` by walking child slots from the root. O(name.length), zero
   * allocation, and there is NO name-keyed Map anywhere in the tree.
   * `undefined` if the name is malformed or any node on the path is not yet
   * materialised.
   */
  nodeByName(name: string): HierarchyNode | undefined;
  /** Every materialised node, in ascending `index`. */
  nodes(): IterableIterator<HierarchyNode>;

  /** `metadata.spacing / 2 ** level`. Pure; never stored per node. */
  spacingAt(level: number): number;
  /**
   * Bounding-sphere radius of EVERY node at `level`. Exact and per-level
   * constant, because `childBoundingBox` halves all three axes uniformly at
   * every level — so no sphere is stored per node. Read this once per level per
   * frame and compute the centre from the box scalars you are already touching.
   */
  radiusAt(level: number): number;
  /** ALLOCATES a `BoundingBox`. For ergonomics and tests, not the frame loop. */
  boundingBoxOf(node: HierarchyNode): BoundingBox;

  /**
   * Expand `node` from ALREADY-RESIDENT bytes. Returns `true` if the node is now
   * `"expanded"`, `false` if the bytes are not in memory or the node is not
   * expandable. NEVER THROWS and never issues a request — safe to call from a
   * render loop. A malformed chunk is recorded as a permanent node failure and
   * returns `false`, exactly as the async path would.
   *
   * Under the default policy this is the path descent actually takes, so
   * crossing a `stepSize` boundary costs ZERO frames of latency.
   */
  tryExpandSync(node: HierarchyNode): boolean;

  /**
   * Ensure `node`'s children are known, fetching its chunk if needed.
   * Idempotent and awaitable by any number of callers; concurrent calls for the
   * same chunk share ONE request. Resolves to `node` itself — never a
   * replacement object.
   *
   * Rejects IMMEDIATELY, with no request, when the node has permanently failed
   * or is inside a retry-backoff window. Aborting via `signal` rejects only THIS
   * call and leaves the node exactly as it was; it does not disturb other
   * callers of the same chunk, whose shared request is only aborted when the
   * last of them lets go.
   */
  expand(node: HierarchyNode, options?: ExpandOptions): Promise<HierarchyNode>;

  /**
   * Fire-and-forget expansion for the render loop. Returns `void`: no promise to
   * drop, no unhandled rejection, no rejected-promise allocation per frame per
   * node.
   *
   * Nothing is swallowed — a failure lands on `node.state === "failed"` and
   * `node.failure`, which the caller reads on its next frame. A no-op when the
   * node is already expanded, expanding, or inside a backoff window; that last
   * clause is what makes an unthrottled per-frame retry storm structurally
   * impossible.
   */
  requestExpand(node: HierarchyNode, signal?: AbortSignal): void;

  /**
   * Expand every unexpanded node, breadth-first, honouring
   * `maxConcurrentChunkRequests`. Under the default policy this is 0 further
   * requests. Rejects with the FIRST failure, fail-fast per Task 2; the
   * partially-expanded tree stays valid and readable.
   *
   * On success, checks the sum of `numPoints` against `metadata.points` and
   * emits `point-count-mismatch` if they differ — the strongest end-to-end check
   * available, and only computable here.
   */
  expandAll(options?: ExpandOptions): Promise<void>;

  /**
   * Clear a node's terminal failure so it is eligible again. The ONLY way a
   * permanent failure (404, 416, malformed chunk) is ever retried — never
   * implicitly, never per frame.
   */
  retry(node: HierarchyNode): void;

  /**
   * Abort every in-flight and queued chunk request. For viewer teardown. Aborted
   * nodes return to `"unexpanded"` with no failure recorded; the tree stays
   * readable and expansion can resume later.
   */
  dispose(reason?: unknown): void;
}

/** Policy knobs shared by both entry points. */
export interface HierarchyOptions {
  /**
   * How hierarchy.bin bytes are acquired.
   *
   * - `"auto"` (DEFAULT): ONE plain unranged GET of hierarchy.bin, capped at
   *   `maxPrefetchBytes`. Every later expansion is a synchronous slice out of
   *   that buffer. If the file exceeds the cap (or the request fails), the body
   *   is cancelled, a `hierarchy-prefetch-skipped` warning is emitted, and the
   *   loader falls back to per-chunk Range requests.
   * - `"always"`: the same plain GET with NO cap. The escape hatch for a host
   *   that does not support Range at all.
   * - `"never"`: strictly on-demand, one Range request per chunk.
   *
   * Why an unranged GET rather than a Range request for the whole file: a 206
   * response is not `Content-Encoding`-compressed by nginx or any major CDN,
   * whereas a 200 is. Measured on autzen's hierarchy.bin: 100,518 B raw, 38,279
   * B brotli, 47,095 B gzip — against 192 Range requests totalling 100,496 B.
   * It also removes any dependency on `Range` support and on `Content-Range`
   * being CORS-exposed.
   */
  readonly prefetch?: "auto" | "never" | "always";
  /**
   * Cap on DECODED hierarchy.bin bytes buffered by the `"auto"` prefetch.
   * Default 16 MiB, roughly 762,600 records. Enforced by a `Content-Length`
   * pre-check (so an oversized file costs ~0 bytes) plus a streaming byte
   * counter that cancels the body mid-download when the response is
   * content-encoded and the header therefore understates the size.
   */
  readonly maxPrefetchBytes?: number;
  /**
   * Max simultaneous hierarchy.bin Range requests. Default 8. Deliberately
   * INDEPENDENT of, and much higher than, Task 4's point-data limit: chunks are
   * 66-5654 B (autzen median 484) against point requests averaging 86 KB.
   */
  readonly maxConcurrentChunkRequests?: number;
  /**
   * Hard cap on node level. Default 32. Node names are strings, so unbounded
   * depth from a hostile file is unbounded string growth and then OOM.
   * Exceeding `metadata.hierarchy.depth` is NOT checked — that field is
   * documented in core as a hint and is nonsense in the synthetic fixture (100,
   * for a 2-level tree). This is the real bound.
   */
  readonly maxDepth?: number;
  /** Cycle/OOM backstop on total materialised nodes. Default 8_000_000. */
  readonly maxNodes?: number;
  /** Attempts before a TRANSIENT failure becomes permanent. Default 3. */
  readonly maxAttempts?: number;
  /**
   * ms to wait before attempt `n` (1-based).
   * Default `min(250 * 2 ** (n - 1), 10_000)`.
   */
  readonly retryDelayMs?: (attempt: number) => number;
  /**
   * Injectable clock, so backoff is deterministic in tests with no fake timers.
   * Defaults to `Date.now`.
   */
  readonly now?: () => number;
}

export interface LoadHierarchyOptions extends HierarchyOptions {
  /**
   * Aborts the request(s) `loadHierarchy` itself issues. Deliberately NOT
   * retained on the returned hierarchy — later expansions take their own
   * signals, mirroring `LoadPointCloudOptions.signal`. Propagates as the
   * original `DOMException`.
   */
  readonly signal?: AbortSignal;
}

export interface CreateHierarchyOptions extends HierarchyOptions {
  /**
   * The WHOLE of hierarchy.bin from offset 0, if you already have it. When
   * present the hierarchy performs no I/O ever: `tryExpandSync` always succeeds
   * and `resident` is `true`.
   *
   * Nothing less than the whole file is usable, because chunk offsets are
   * absolute, chunks are NOT in file order (autzen's seeds in ascending file
   * offset are r6206, r2060, r2262, r6004, … — neither ascending, descending
   * nor name order) and they do NOT tile the file (autzen has a stranded 22-byte
   * orphan at offset 43,802). hierarchy.bin can never be parsed as a stream.
   */
  readonly buffer?: ArrayBuffer | ArrayBufferView;
}

export interface ExpandOptions {
  readonly signal?: AbortSignal;
}
