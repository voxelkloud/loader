export { loadPointCloudSource } from "./load.js";
export { parsePointCloudSource } from "./parse.js";
export { resolvePointCloudUrls } from "./urls.js";
export { VoxelkloudError, isVoxelkloudError } from "./errors.js";
export { createHierarchy, loadHierarchy } from "./hierarchy.js";
export { createPointLayout } from "./point-data-layout.js";
export {
  createPointDataRequest,
  decodePointData,
} from "./point-data-decode.js";
export { fetchNodeBytes } from "./point-data-fetch.js";
export { decompressNodeBytes } from "./point-data-brotli.js";
export { loadPointData } from "./point-data.js";

export type {
  BrotliDecompress,
  DecodedArray,
  DecodedAttribute,
  DecodedColors,
  DecodedPointData,
  GpuVertexFormat,
  LoadPointDataOptions,
  NodeBytes,
  OriginPolicy,
  PointDataOptions,
  PointDataRequest,
  PointFieldCodec,
  PointFieldPlan,
  PointNodeRef,
  PointPositionFrame,
  PointRecordLayout,
  PositionFormat,
  ScalarLane,
} from "./point-data-types.js";

export type {
  CreateHierarchyOptions,
  ExpandOptions,
  HierarchyChildren,
  HierarchyChunkRef,
  HierarchyFailure,
  HierarchyNode,
  HierarchyNodeState,
  HierarchyOptions,
  HierarchyStats,
  LoadHierarchyOptions,
  PointCloudHierarchy,
} from "./hierarchy-types.js";

export type {
  VoxelkloudErrorCode,
  VoxelkloudErrorOptions,
} from "./errors.js";
export type { ResolvePointCloudUrlsOptions } from "./urls.js";
export type { LoadPointCloudOptions } from "./load.js";
export type {
  AttributeRole,
  FetchLike,
  PointAttribute,
  PointCloudSource,
  PointCloudTransport,
  PointCloudTransportOptions,
  PointCloudUrls,
  PointCloudWarning,
  PointCloudWarningCode,
} from "./types.js";

// Type-only re-exports of the manifest types. `source.metadata` is typed by
// these; @voxelkloud/core is an implementation dependency of this package, so
// forcing consumers to install it just to name a type they got from us is a
// papercut. Zero runtime cost.
export type {
  BoundingBox,
  ChildIndex,
  HierarchyMetadata,
  PointAttributeTypeName,
  PointCloudEncoding,
  PointCloudMetadata,
  Vec3,
} from "@voxelkloud/core";
