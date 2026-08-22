/**
 * Ambient declaration for the `#brotli-native` subpath import.
 *
 * The runtime target is chosen by package.json's `"imports"` condition —
 * `point-data-brotli-node.js` under Node, `point-data-brotli-none.js`
 * everywhere else — which is what keeps `node:zlib` out of every browser
 * bundle. Both branches export the same shape, so declaring it here lets
 * `tsc` and `tsup` typecheck without resolving into `dist/`, which does not
 * exist yet when the declaration build runs.
 */
declare module "#brotli-native" {
  export const nativeBrotli: ((input: Uint8Array) => Uint8Array) | undefined;
}
