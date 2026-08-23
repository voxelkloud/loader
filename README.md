# @voxelkloud/loader

The engine: it identifies which format a URL is, and hands off to that driver.
No three and no DOM in its module graph, so it runs in a worker or in Node.

```sh
npm install @voxelkloud/loader
```

```ts
import { loadPointCloud } from "@voxelkloud/loader";

const { source, tree, format } = await loadPointCloud(url);
format.id;                 // "potree-v2"
source.pointCount;         // 10653336
source.tightBoundingBox;   // absolute CRS
```

The returned source satisfies `PointCloudSourceBase` whichever driver served it.
Reach for a driver's own fields only when you have decided to be
format-specific.

## How it decides

Drivers are ordered by `sniffUrl`, which is URL shape only and costs nothing.
Each candidate then names the document that would identify it —
`metadata.json` for Potree, `ept.json` for EPT — and those are fetched, **once
each even when several drivers name the same one**, until a driver reports
decisive confidence. That document is handed to the winning driver, so
identification never costs a duplicate round trip.

A 404 on one candidate is an answer, not a failure: it is how "not this format"
presents. When nothing matches, the thrown `"unsupported-format"` names what was
tried and what the server actually served.

Pass `format: "potree-v2"` to skip sniffing entirely — use it when the format is
known and a wrong guess should be an error rather than a fallback.

## Drivers

`@voxelkloud/format-potree` is registered on the first load, so zero-config
keeps working. That is a DX decision, not a structural one. The other drivers
are separate packages and are NOT registered by default, because each pulls in a
wasm LAZ decoder and an app that reads one format should not bundle another's
codec to find that out:

```ts
import { formats } from "@voxelkloud/loader";
import { copcFormat } from "@voxelkloud/format-copc";
import { eptFormat } from "@voxelkloud/format-ept";

formats.register(copcFormat).register(eptFormat);
formats.unregister("potree-v2");
```

Once registered, the URL decides. `loadPointCloud` returns the driver that
claimed it, the source, the tree, and `openPoints` — a factory for the reader
that turns a node into vertices, which is the last thing that stays
format-specific:

```ts
const { format, source, tree, openPoints } = await loadPointCloud(url);
format.id; // "potree-v2" | "copc" | "ept"
view.addCloud(source, tree, openPoints);
```

MIT.
