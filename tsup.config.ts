import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    // Separate entry points, not bundled into the main one:
    // - brotli/index.ts carries the ~216 KB vendored decoder and is reached
    //   only through the "@voxelkloud/loader/brotli" subpath.
    // - the two #brotli-native branches are resolved by the runtime's
    //   "imports" condition, so they must exist as standalone files.
    "src/brotli/index.ts",
    "src/point-data-brotli-node.ts",
    "src/point-data-brotli-none.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Both must stay unresolved at build time: node:zlib is reached only from the
  // "node" branch, and #brotli-native is chosen by the runtime's "imports"
  // condition, not by the bundler.
  external: ["node:zlib", "#brotli-native"],
  // MIT requires the notice to travel with "all copies or substantial
  // portions", and the vendored decoder IS a substantial portion. esbuild
  // strips ordinary block comments while bundling, so without this the
  // published tarball carries the Brotli Authors' code and not their notice.
  esbuildOptions(options) {
    options.legalComments = "inline";
  },
});
