// The mutable node implementation behind the readonly `HierarchyNode`
// interface. INTERNAL — never exported from index.ts.

import type { ChildIndex } from "@voxelkloud/core";
import type {
  HierarchyChildren,
  HierarchyChunkRef,
  HierarchyFailure,
  HierarchyNode,
  HierarchyNodeState,
} from "./hierarchy-types.js";
import type { PointCloudSource } from "./types.js";

/**
 * The single frozen all-undefined tuple shared by every childless node — 3525
 * of autzen's 4377 (80.5%) — and by every node that is not yet expanded.
 *
 * Identity is meaningful: the parser checks `children !== EMPTY_CHILDREN`
 * before freezing, and never writes into this array.
 */
export const EMPTY_CHILDREN: HierarchyChildren = Object.freeze([
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
]) as HierarchyChildren;

/** Mutable during expansion; frozen the instant it reaches `"expanded"`. */
export class Node implements HierarchyNode {
  declare readonly index: number;
  declare readonly name: string;
  declare readonly level: number;
  declare readonly childIndex: ChildIndex;
  declare readonly parent: HierarchyNode | undefined;

  children: HierarchyChildren = EMPTY_CHILDREN;
  childMask: number | undefined = undefined;
  numPoints = 0;
  byteOffset: number | undefined = undefined;
  byteSize: number | undefined = undefined;
  chunk: HierarchyChunkRef | undefined = undefined;
  state: HierarchyNodeState = "unexpanded";
  failure: HierarchyFailure | undefined = undefined;
  /**
   * Attempts made against this node, kept SEPARATE from `failure` because
   * `failure` is cleared on a successful retry while the count must survive it
   * — otherwise every retry would reset to attempt 1 and `maxAttempts` could
   * never be reached. Internal; not on the public `HierarchyNode`.
   */
  attempts = 0;

  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;

  constructor(
    index: number,
    name: string,
    level: number,
    childIndex: ChildIndex,
    parent: HierarchyNode | undefined,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ) {
    Object.defineProperty(this, "index", { value: index, enumerable: true });
    Object.defineProperty(this, "name", { value: name, enumerable: true });
    Object.defineProperty(this, "level", { value: level, enumerable: true });
    Object.defineProperty(this, "childIndex", {
      value: childIndex,
      enumerable: true,
    });
    Object.defineProperty(this, "parent", { value: parent, enumerable: true });
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxY = maxY;
    this.maxZ = maxZ;
  }
}

/**
 * The root IS a proxy whose chunk happens to start at offset 0 — the one
 * genuinely elegant idea in the reference. It makes the first chunk load and
 * every subsequent chunk load literally the same code path, with no root
 * special case anywhere.
 *
 * Two deliberate divergences from the reference's root seeding:
 * - `byteOffset` is NOT pre-set to 0. That is a lie until record 0 of the root
 *   chunk arrives, and in the reference it is a Number planted in a BigInt
 *   world that only avoids a TypeError because of unmarked statement ordering.
 * - nothing is fired un-awaited.
 */
export function makeRootNode(source: PointCloudSource): Node {
  const { min, max } = source.metadata.boundingBox;
  const root = new Node(
    0,
    "r",
    0,
    0,
    undefined,
    min[0],
    min[1],
    min[2],
    max[0],
    max[1],
    max[2],
  );
  root.chunk = Object.freeze({
    byteOffset: 0,
    byteSize: source.metadata.hierarchy.firstChunkSize,
  });
  return root;
}

/**
 * Create a child node, halving the parent box along the octant bits.
 *
 * The arithmetic is written in EXACTLY the form of core's `childBoundingBox`
 * (`lo += size/2` / `hi -= size/2`, never `(lo+hi)/2`) so the two are
 * bit-identical by construction rather than by luck — a property test over
 * random boxes times all 8 octants pins it. Fused here rather than delegated so
 * the hot parse loop does not allocate a `BoundingBox` per node.
 */
export function makeChildNode(
  parent: Node,
  childIndex: ChildIndex,
  index: number,
): Node {
  const sizeX = parent.maxX - parent.minX;
  const sizeY = parent.maxY - parent.minY;
  const sizeZ = parent.maxZ - parent.minZ;

  let minX = parent.minX;
  let maxX = parent.maxX;
  let minY = parent.minY;
  let maxY = parent.maxY;
  let minZ = parent.minZ;
  let maxZ = parent.maxZ;

  if (childIndex & 0b001) minZ += sizeZ / 2;
  else maxZ -= sizeZ / 2;
  if (childIndex & 0b010) minY += sizeY / 2;
  else maxY -= sizeY / 2;
  if (childIndex & 0b100) minX += sizeX / 2;
  else maxX -= sizeX / 2;

  return new Node(
    index,
    parent.name + String(childIndex),
    parent.level + 1,
    childIndex,
    parent,
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
  );
}

/**
 * Half-diagonal of the ROOT box. Every node at level L has bounding-sphere
 * radius `rootHalfDiagonal / 2 ** L`, exactly, because `childBoundingBox` halves
 * all three axes uniformly at every level — true whether or not the root box is
 * a cube. That deletes 32 bytes per node that the reference stores on every one.
 */
export function rootHalfDiagonal(root: Node): number {
  return (
    0.5 *
    Math.hypot(root.maxX - root.minX, root.maxY - root.minY, root.maxZ - root.minZ)
  );
}
