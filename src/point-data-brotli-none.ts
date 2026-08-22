// The "default" branch of the #brotli-native imports condition. Exists so no
// browser bundler ever resolves node:zlib and pulls in a polyfill shim.

export const nativeBrotli: ((input: Uint8Array) => Uint8Array) | undefined =
  undefined;
