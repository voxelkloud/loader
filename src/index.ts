// @voxelkloud/loader — the engine.
//
// It knows about transport, identification and dispatch. It knows about NO
// format: `metadata.json`, `hierarchy.bin`, the 22-byte record and the
// DEFAULT/BROTLI encodings all live in @voxelkloud/format-potree, alongside
// where COPC, EPT and 3D Tiles will live. What this package decides is which
// driver a URL belongs to and how the caller's auth reaches it.
//
// Potree v2 is registered by default. That is a DX decision, not a structural
// one — it is the format this project started with and zero-config must keep
// working — and it is one `formats.unregister("potree-v2")` away from gone.
// The registration happens on the first load rather than at import: see
// `defaults.ts` for why a module-scope register would be unsafe here.
export { loadPointCloud, loadPointCloudSource } from "./load.js";
export type { LoadedPointCloud, LoadPointCloudOptions } from "./load.js";
export { FormatRegistry, formats } from "./registry.js";
export { ensureDefaultFormats } from "./defaults.js";

// The neutral vocabulary, re-exported so a consumer names one dependency rather
// than two for types it received from us. Zero runtime cost.
export {
  VoxelkloudError,
  isVoxelkloudError,
  POINT_ATTRIBUTE_TYPE_SIZE,
  UNDECODABLE_ATTRIBUTE_TYPES,
  isPointAttributeTypeName,
  childBoundingBox,
  mortonDecode3,
  mortonEncode3,
} from "@voxelkloud/core";
export type {
  AttributeRole,
  BoundingBox,
  ChildIndex,
  FetchLike,
  FormatProbe,
  LoadSourceOptions,
  PointAttribute,
  PointAttributeTypeName,
  PointCloudFormat,
  PointCloudNode,
  PointCloudSourceBase,
  PointCloudTransport,
  PointCloudTransportOptions,
  PointCloudTreeBase,
  PointCloudWarning,
  PointReader,
  PointReaderFactory,
  OpenPointsOptions,
  Vec3,
  VoxelkloudErrorCode,
  VoxelkloudErrorOptions,
} from "@voxelkloud/core";

// ── Compatibility surface ───────────────────────────────────────────────────
//
// Everything below moved to @voxelkloud/format-potree and is re-exported here
// so that existing code keeps resolving. Import it from the driver directly:
// naming the format you depend on is the point of the split.
export {
  createHierarchy,
  createPointDataRequest,
  createPointLayout,
  decodePointData,
  decompressNodeBytes,
  fetchNodeBytes,
  loadHierarchy,
  loadPointData,
  parsePointCloudSource,
  potreeFormat,
  resolvePointCloudUrls,
} from "@voxelkloud/format-potree";
export type {
  BrotliDecompress,
  CreateHierarchyOptions,
  DecodedArray,
  DecodedAttribute,
  DecodedColors,
  DecodedPointData,
  ExpandOptions,
  GpuVertexFormat,
  HierarchyChildren,
  HierarchyChunkRef,
  HierarchyFailure,
  HierarchyMetadata,
  HierarchyNode,
  HierarchyNodeState,
  HierarchyOptions,
  HierarchyStats,
  LoadHierarchyOptions,
  LoadPointDataOptions,
  NodeBytes,
  OriginPolicy,
  PointCloudEncoding,
  PointCloudHierarchy,
  PointCloudMetadata,
  PointCloudSource,
  PointCloudUrls,
  PointCloudWarningCode,
  PointDataOptions,
  PointDataRequest,
  PointFieldCodec,
  PointFieldPlan,
  PointNodeRef,
  PointPositionFrame,
  PointRecordLayout,
  PositionFormat,
  ScalarLane,
} from "@voxelkloud/format-potree";
