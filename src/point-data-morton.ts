// Morton (Z-order) de-interleaving for the BROTLI path. INTERNAL.
//
// Kept in its own file because it is the one piece of the decoder with a
// bit-exact external oracle: dealign24b can be checked against a bigint
// reference encoder over its entire 2^24 input domain, and its test is a
// standalone sweep.

/**
 * Extract every third bit from 24 interleaved bits, yielding 8.
 *
 * The hex-mask form below was verified equal to the reference's
 * binary-literal form over ALL 2^24 inputs: 0 mismatches.
 */
export function dealign24b(m: number): number {
  let x = m;
  x = ((x & 0x208208) >> 2) | (x & 0x041041);
  x = ((x & 0x0c00c0) >> 4) | (x & 0x003003);
  x = ((x & 0x00f000) >> 8) | (x & 0x00000f);
  return x & 0xff;
}

/** Scratch triple, reused so the hot loop allocates nothing. */
export interface MortonTriple {
  x: number;
  y: number;
  z: number;
}

/**
 * Decode one 16-byte morton position record into `out`.
 *
 * Bytes 0..8 are the HIGH morton word and bytes 8..16 the LOW word, each using
 * 48 of its 64 bits.
 *
 * TWO deliberate departures from the reference:
 *
 * 1. The high-bits guard `if (mc_1 != 0 || mc_2 != 0)` is DROPPED, not widened.
 *    `mc_2` is the high dword of the LOW word — bits 8..15, already consumed by
 *    the fast path — so testing it is merely over-conservative. The dword NEVER
 *    tested is `mc_0`, which supplies bits 27..31: encoding (X=2^27, Y=0, Z=0)
 *    and decoding both ways gives guarded (0,0,0) against unguarded
 *    (134217728,0,0) — the guard silently discards the whole coordinate. OR-ing
 *    zero is a no-op, so running unconditionally is correct and branch-free.
 *    The real fixture cannot regression-test this (0 of 341,989 points have a
 *    non-zero mc_0, max component 569), which is precisely why the guard must be
 *    removed rather than trusted.
 * 2. `>>> 0` on each result. `dealign24b(d) << 24` is negative in int32 for
 *    `d >= 0x80`, so the reference yields negative coordinates above 2^31.
 */
export function decodeMortonPosition(
  dv: DataView,
  offset: number,
  out: MortonTriple,
): void {
  const mc0 = dv.getUint32(offset + 4, true); // high word, high dword: bits 27..31
  const mc1 = dv.getUint32(offset + 0, true); // high word, low dword:  bits 16..26
  const mc2 = dv.getUint32(offset + 12, true); // low word, high dword: bits 8..15
  const mc3 = dv.getUint32(offset + 8, true); // low word, low dword:   bits 0..7

  const a = (mc3 & 0x00ffffff) >>> 0;
  const b = ((mc3 >>> 24) | (mc2 << 8)) >>> 0;
  const c = (mc1 & 0x00ffffff) >>> 0;
  const d = ((mc1 >>> 24) | (mc0 << 8)) >>> 0;

  out.x =
    (dealign24b(a) |
      (dealign24b(b) << 8) |
      (dealign24b(c) << 16) |
      (dealign24b(d) << 24)) >>>
    0;
  out.y =
    (dealign24b(a >>> 1) |
      (dealign24b(b >>> 1) << 8) |
      (dealign24b(c >>> 1) << 16) |
      (dealign24b(d >>> 1) << 24)) >>>
    0;
  out.z =
    (dealign24b(a >>> 2) |
      (dealign24b(b >>> 2) << 8) |
      (dealign24b(c >>> 2) << 16) |
      (dealign24b(d >>> 2) << 24)) >>>
    0;
}

/**
 * Decode one 8-byte morton colour record into `out` as r/g/b.
 *
 * Same structure as the position decode but two dwords and three channels, both
 * dwords always used. Only 48 of the 64 bits carry data — verified: 0 of 341,989
 * fixture points have any bit at or above 48 set.
 */
export function decodeMortonColor(
  dv: DataView,
  offset: number,
  out: MortonTriple,
): void {
  const mc0 = dv.getUint32(offset + 4, true);
  const mc1 = dv.getUint32(offset + 0, true);

  const a = (mc1 & 0x00ffffff) >>> 0;
  const b = ((mc1 >>> 24) | (mc0 << 8)) >>> 0;

  out.x = (dealign24b(a) | (dealign24b(b) << 8)) >>> 0;
  out.y = (dealign24b(a >>> 1) | (dealign24b(b >>> 1) << 8)) >>> 0;
  out.z = (dealign24b(a >>> 2) | (dealign24b(b >>> 2) << 8)) >>> 0;
}
