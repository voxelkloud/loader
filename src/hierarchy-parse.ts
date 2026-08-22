// The pure synchronous chunk parser — the only place 22-byte hierarchy.bin
// records are decoded. INTERNAL.
//
// Knows nothing about transport, HTTP, promises or the resident buffer: it is
// handed (DataView, offset, size). That is mandatory, not stylistic, because
// chunks are NOT in file order (autzen's seeds in ascending file offset are
// r6206, r2060, r2262, r6004, …) and do NOT tile the file (a stranded 22-byte
// orphan sits at offset 43,802), so hierarchy.bin can never be parsed as a
// stream.

import {
  HIERARCHY_NODE_BYTE_SIZE as REC,
  HierarchyNodeType,
} from "@voxelkloud/core";
import type { ChildIndex } from "@voxelkloud/core";
import { fail } from "./errors.js";
import { EMPTY_CHILDREN, Node, makeChildNode } from "./hierarchy-node.js";
import type { HierarchyChildren } from "./hierarchy-types.js";
import type { PointCloudSource, PointCloudWarningCode } from "./types.js";

/** Everything the parser is allowed to touch on the owning hierarchy. */
export interface ParseContext {
  readonly source: PointCloudSource;
  /** The live node array. Named `nodeList` because the public hierarchy
   *  exposes `nodes()` as an iterator method. */
  readonly nodeList: Node[];
  readonly visitedChunks: Set<number>;
  readonly maxNodes: number;
  readonly maxDepth: number;
  knownPoints: number;
  maxLevel: number;
  chunksParsed: number;
  warn(code: PointCloudWarningCode, path: string, message: string): void;
  /** Per-hierarchy scratch, grown to the largest chunk seen. */
  scratch: Scratch | undefined;
}

export interface Scratch {
  capacity: number;
  type: Uint8Array;
  mask: Uint8Array;
  points: Uint32Array;
  off: Float64Array;
  size: Float64Array;
  parent: Int32Array;
  child: Uint8Array;
  level: Int32Array;
}

function ensureScratch(ctx: ParseContext, n: number): Scratch {
  const s = ctx.scratch;
  if (s !== undefined && s.capacity >= n) return s;
  const next: Scratch = {
    capacity: n,
    type: new Uint8Array(n),
    mask: new Uint8Array(n),
    points: new Uint32Array(n),
    off: new Float64Array(n),
    size: new Float64Array(n),
    parent: new Int32Array(n),
    child: new Uint8Array(n),
    level: new Int32Array(n),
  };
  ctx.scratch = next;
  return next;
}

/**
 * Decode an i64 LE as a JavaScript number, rejecting anything not exactly
 * representable.
 *
 * Strictly stronger than reading a bigint: bigint silently accepts a hostile
 * 2^62 offset that then produces an unsatisfiable Range header, whereas this
 * names it. Verified: every i64 high word in all three fixtures is exactly 0.
 */
export function readU53(
  dv: DataView,
  at: number,
  field: string,
  path: string,
): number {
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  if (hi >= 0x80000000) {
    fail(
      "hierarchy-error",
      `${path}: ${field} has its sign bit set, so the record decodes to a ` +
        `negative i64. hierarchy.bin is corrupt.`,
      { path },
    );
  }
  if (hi > 0x1fffff) {
    fail(
      "hierarchy-error",
      `${path}: ${field} is >= 2^53 and cannot be represented exactly. ` +
        `hierarchy.bin is corrupt (the largest value in any known converter ` +
        `output is 372,487,605).`,
      { path },
    );
  }
  return lo + hi * 4294967296;
}

/**
 * Parse one chunk and splice its nodes into the live tree.
 *
 * Three strictly ordered phases. Phases A and B cannot touch the live tree;
 * phase C cannot fail. So a malformed record at position 200 of 257 leaves the
 * seed byte-for-byte as it was — still `"unexpanded"`, still retryable — where
 * the reference writes children into the live tree as it goes and leaves a
 * half-expanded node with no way to detect it.
 */
export function parseChunkInto(
  ctx: ParseContext,
  seed: Node,
  dv: DataView,
  /** Where the chunk starts INSIDE `dv` — 0 when `dv` wraps a lone chunk. */
  chunkStart: number,
  chunkSize: number,
): void {
  const path = seed.name;
  // Cycle detection keys on the chunk's ABSOLUTE offset in hierarchy.bin, not
  // on its position in the passed view: in per-chunk mode every chunk arrives
  // in its own buffer starting at 0, so keying on `chunkStart` would flag the
  // second chunk as a cycle.
  const chunkKey = seed.chunk?.byteOffset ?? chunkStart;

  // ── pre-checks ──────────────────────────────────────────────────────────
  if (chunkSize === 0 || chunkSize % REC !== 0) {
    fail(
      "hierarchy-error",
      `${path}: chunk size ${chunkSize} is not a positive multiple of the ` +
        `${REC}-byte node record.`,
      { path },
    );
  }
  if (chunkStart < 0 || chunkStart + chunkSize > dv.byteLength) {
    fail(
      "hierarchy-error",
      `${path}: chunk [${chunkStart}, ${chunkStart + chunkSize}) falls ` +
        `outside hierarchy.bin (${dv.byteLength} bytes).`,
      { path },
    );
  }
  if (ctx.visitedChunks.has(chunkKey)) {
    fail(
      "hierarchy-error",
      `${path}: the chunk at byte ${chunkKey} of hierarchy.bin has already ` +
        `been parsed, so the file contains a cycle.`,
      { path },
    );
  }

  const n = chunkSize / REC;
  if (ctx.nodeList.length + n - 1 > ctx.maxNodes) {
    fail(
      "hierarchy-error",
      `${path}: parsing this chunk would exceed maxNodes (${ctx.maxNodes}).`,
      { path },
    );
  }

  const s = ensureScratch(ctx, n);

  // ── PHASE A: decode + BFS reconstruction + validation, into SCRATCH ──────
  //
  // scratch doubles as the BFS queue: hierarchy.bin chunks are written in exact
  // level-order with children in ascending childIndex, so record i describes
  // slot i. The read cursor only advances and children are only appended at
  // tail > i — a textbook FIFO, and safe only because a BFS queue never writes
  // behind its read cursor.
  //
  // The reference's three-way branch collapses to two here: slot 0 is ALWAYS
  // the node being expanded, and a node is only ever expanded when it is a
  // proxy, so its first branch applies iff i === 0. That removes the
  // load-bearing statement ordering the reference depends on.
  s.parent[0] = -1;
  s.child[0] = 0;
  s.level[0] = seed.level;
  let tail = 1;

  for (let i = 0; i < n; i++) {
    if (i >= tail) {
      fail(
        "hierarchy-error",
        `${path}#${i}: the chunk declares ${n} records but the breadth-first ` +
          `walk ran out of parents after ${tail}. The records are not in ` +
          `level order, or the chunk is truncated.`,
        { path: `${path}#${i}` },
      );
    }
    if (s.level[i]! > ctx.maxDepth) {
      fail(
        "hierarchy-error",
        `${path}#${i}: node level ${s.level[i]} exceeds maxDepth ` +
          `(${ctx.maxDepth}).`,
        { path: `${path}#${i}` },
      );
    }

    const o = chunkStart + i * REC;
    const t = dv.getUint8(o);
    if (i === 0 && t === HierarchyNodeType.Proxy) {
      fail(
        "hierarchy-error",
        `${path}#0: the first record of a chunk must describe the node the ` +
          `chunk belongs to, but it is a proxy. Record 0 is the only place a ` +
          `proxy's octree location and real childMask exist.`,
        { path: `${path}#0` },
      );
    }

    const m = dv.getUint8(o + 1);
    const p = dv.getUint32(o + 2, true);
    const bo = readU53(dv, o + 6, "byteOffset", `${path}#${i}`);
    const bs = readU53(dv, o + 14, "byteSize", `${path}#${i}`);

    s.type[i] = t;
    s.mask[i] = m;
    s.points[i] = p;
    s.off[i] = bo;
    s.size[i] = bs;

    if (i > 0 && t === HierarchyNodeType.Proxy) {
      if (bs === 0 || bs % REC !== 0) {
        fail(
          "hierarchy-error",
          `${path}#${i}: proxy chunk size ${bs} is not a positive multiple ` +
            `of ${REC}.`,
          { path: `${path}#${i}` },
        );
      }
      // A proxy names NO children in this chunk; its real mask lives at record
      // 0 of its own chunk.
      continue;
    }

    for (let c = 0; c < 8; c++) {
      if (((m >> c) & 1) === 0) continue;
      if (tail >= n) {
        fail(
          "hierarchy-error",
          `${path}#${i}: the child masks in this chunk name more than the ` +
            `${n} records it contains.`,
          { path: `${path}#${i}` },
        );
      }
      s.parent[tail] = i;
      s.child[tail] = c;
      s.level[tail] = s.level[i]! + 1;
      tail++;
    }
  }

  if (tail !== n) {
    fail(
      "hierarchy-error",
      `${path}: the chunk contains ${n} records but its child masks name ` +
        `only ${tail} nodes. hierarchy.bin is corrupt or misaligned.`,
      { path },
    );
  }

  // ── PHASE B: build the node objects, DETACHED from the live tree ─────────
  const out = new Array<Node>(n);
  out[0] = seed;
  const base = ctx.nodeList.length;
  for (let k = 1; k < n; k++) {
    // s.parent[k] < k is guaranteed by the BFS reconstruction above.
    const parent = out[s.parent[k]!]!;
    out[k] = makeChildNode(parent, s.child[k] as ChildIndex, base + k - 1);
  }

  // ── PHASE C: apply records, link, splice, freeze. INFALLIBLE. ────────────
  const seedPointsBefore = seed.numPoints;
  const { source } = ctx;

  for (let k = 0; k < n; k++) {
    const node = out[k]!;
    if (k > 0 && s.type[k] === HierarchyNodeType.Proxy) {
      node.chunk = Object.freeze({ byteOffset: s.off[k]!, byteSize: s.size[k]! });
      node.numPoints = s.points[k]!;
      node.state = "unexpanded";
      // byteOffset / byteSize / childMask stay undefined — the tri-state. A
      // proxy's on-disk childMask is ALWAYS 0 (191/191 on autzen) and is a lie;
      // it is read and discarded.
      continue;
    }

    node.byteOffset = s.off[k]!;
    node.byteSize = s.size[k]!;

    if (s.size[k] === 0 && s.points[k]! > 0) {
      // potree/potree#1125: some inner nodes erroneously report >0 points.
      // byteSize is the trustworthy field.
      node.numPoints = 0;
      ctx.warn(
        "zero-byte-node",
        node.name,
        `Node ${node.name} claims ${s.points[k]} points but occupies 0 bytes ` +
          `of octree.bin; its point count has been forced to 0 ` +
          `(potree/potree#1125). Applies to any further such nodes.`,
      );
    } else {
      node.numPoints = s.points[k]!;
      if (
        !source.isBrotli &&
        s.points[k]! * source.bytesPerPoint !== s.size[k]
      ) {
        ctx.warn(
          "stride-mismatch",
          node.name,
          `Node ${node.name} declares ${s.points[k]} points and ` +
            `${s.size[k]} bytes, but the manifest's attributes imply ` +
            `${source.bytesPerPoint} bytes per point ` +
            `(${s.points[k]! * source.bytesPerPoint}). hierarchy.bin and ` +
            `metadata.json disagree about the record layout. Applies to any ` +
            `further such nodes.`,
        );
      }
    }

    node.childMask = s.mask[k]!;
    node.children =
      s.mask[k] === 0
        ? EMPTY_CHILDREN
        : ([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
          ] as unknown as HierarchyChildren);
    node.state = "expanded";
  }

  // Link. No k has s.parent[k] pointing at a proxy: proxies `continue`d above.
  for (let k = 1; k < n; k++) {
    // The tuple is only frozen at the end of this phase, so it is still
    // writable here; the readonly type is the public contract, not the
    // construction-time one.
    const slots = out[s.parent[k]!]!.children as unknown as Array<
      Node | undefined
    >;
    slots[s.child[k]!] = out[k]!;
  }

  ctx.knownPoints += out[0]!.numPoints - seedPointsBefore;
  for (let k = 1; k < n; k++) {
    ctx.knownPoints += out[k]!.numPoints;
    ctx.nodeList.push(out[k]!);
    if (out[k]!.level > ctx.maxLevel) ctx.maxLevel = out[k]!.level;
  }

  ctx.visitedChunks.add(chunkKey);
  ctx.chunksParsed++;

  for (let k = 0; k < n; k++) {
    const node = out[k]!;
    if (node.state !== "expanded") continue;
    if (node.children !== EMPTY_CHILDREN) Object.freeze(node.children);
    Object.freeze(node);
  }
}
