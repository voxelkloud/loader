import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // package.json's "imports" maps #brotli-native into dist/, which is the
      // published layout. Tests run against src/, so point it at the source of
      // the "node" branch — the tests run in Node, which is the branch the
      // condition would pick anyway.
      "#brotli-native": fileURLToPath(
        new URL("./src/point-data-brotli-node.ts", import.meta.url),
      ),
    },
  },
});
