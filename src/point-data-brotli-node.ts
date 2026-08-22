// The "node" branch of the #brotli-native imports condition. The ONLY file in
// this package that mentions node:zlib, so no browser bundler ever resolves it.

import { brotliDecompressSync } from "node:zlib";

export const nativeBrotli = (input: Uint8Array): Uint8Array =>
  new Uint8Array(brotliDecompressSync(input));
