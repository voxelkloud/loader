# @voxelkloud/loader

Streaming loader for Potree v2 point clouds. No three, no DOM, no GPU in its
module graph, so it runs in a browser, a worker, or Node — for rendering,
inspection, or conversion.

```sh
npm install @voxelkloud/loader
```

```ts
import { loadHierarchy, loadPointCloudSource } from "@voxelkloud/loader";

const source = await loadPointCloudSource("https://example.com/clouds/autzen/");
source.metadata.points;    // 10653336
source.attributes;         // name, type, numElements, min/max, role
source.warnings;           // tolerated anomalies, collected instead of thrown

const hierarchy = await loadHierarchy(source);
await hierarchy.expandAll();
```

Both encodings. `DEFAULT`'s interleaved stride and `BROTLI`'s planar 47 B/pt
blocks with morton-coded positions and colour.

Positions come out float32 RELATIVE to the cloud origin, because absolute
float32 loses 0.030 m on autzen — three times the file's own quantum. Pass
`positionFormat: "int32"` for exact values.

Hierarchy fetching is EAGER BYTES, LAZY TREE by default: one unranged GET of
the whole `hierarchy.bin` (100 KB raw, 38 KB on the wire for autzen, against 192
Range requests), with only the root chunk materialised. Every later expansion is
a synchronous slice, so descent costs no frames. `prefetch: "never"` switches to
the streaming path.

### BROTLI clouds

No browser exposes a brotli decompressor to JS, so those clouds need the opt-in
decoder:

```ts
const { brotliDecompress } = await import("@voxelkloud/loader/brotli");
```

A separate subpath on purpose — the vendored decoder must never land in a bundle
that does not need it. Node finds `zlib` on its own.

Every failure is one `VoxelkloudError` with a `code` you switch on, plus `path`,
`url` and `status`. Use `isVoxelkloudError`, not `instanceof`.

Full documentation: [voxelkloud](https://github.com/voxelkloud/voxelkloud).

MIT. Vendors the Brotli Authors' reference decoder; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
