// Hand-written assertion helpers. This is what replaces a schema library: the
// package ships zero runtime dependencies, and every message follows one shape:
//
//   attributes[5].min: expected an array of 1 finite number (numElements === 1),
//   received an array of 3 numbers: [0, 0, 0]
//
// INTERNAL — not exported from index.ts.

import type { Vec3 } from "@voxelkloud/core";
import { fail } from "./errors.js";

/** A short, safe rendering of an arbitrary value for an error message. */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    const head = value
      .slice(0, 8)
      .map((v) => (typeof v === "object" && v !== null ? "…" : String(v)))
      .join(", ");
    return `an array of ${value.length} ${
      value.length === 1 ? "item" : "items"
    }: [${head}${value.length > 8 ? ", …" : ""}]`;
  }
  switch (typeof value) {
    case "string":
      return `the string ${JSON.stringify(
        value.length > 60 ? `${value.slice(0, 60)}…` : value,
      )}`;
    case "number":
    case "boolean":
      return `the ${typeof value} ${String(value)}`;
    case "object":
      return `an object with keys [${Object.keys(value as object)
        .slice(0, 8)
        .join(", ")}]`;
    default:
      return `a ${typeof value}`;
  }
}

function bad(path: string, expected: string, received: unknown): never {
  fail(
    "invalid-metadata",
    `${path || "<root>"}: expected ${expected}, received ${describeValue(
      received,
    )}`,
    { path },
  );
}

/**
 * A plain JSON object. `typeof null === "object"` is the sharp edge here, and
 * arrays are excluded too.
 */
export function expectRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    bad(path, "an object", value);
  }
  return value as Record<string, unknown>;
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") bad(path, "a string", value);
  return value;
}

/** A string, defaulted when absent. Present-but-wrong-type still throws. */
export function optionalString(
  value: unknown,
  path: string,
  fallback: string,
): string {
  if (value === undefined) return fallback;
  return expectString(value, path);
}

export function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    bad(path, "a finite number", value);
  }
  return value;
}

export function expectInteger(
  value: unknown,
  path: string,
  { min }: { min: number },
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min
  ) {
    bad(path, `a safe integer >= ${min}`, value);
  }
  return value;
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) bad(path, "an array", value);
  return value;
}

/**
 * An array of finite numbers of an exact length. `context` explains WHY that
 * length is required, which is the difference between an actionable message and
 * a puzzle.
 */
export function expectNumberArray(
  value: unknown,
  path: string,
  length: number,
  context: string,
): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    bad(
      path,
      `an array of ${length} finite ${
        length === 1 ? "number" : "numbers"
      } (${context})`,
      value,
    );
  }
  return value.map((v, i) => expectFiniteNumber(v, `${path}[${i}]`));
}

export function expectVec3(value: unknown, path: string): Vec3 {
  const [x, y, z] = expectNumberArray(value, path, 3, "a 3-vector");
  // Non-null assertions are safe: expectNumberArray guarantees length 3.
  return Object.freeze([x!, y!, z!]) as Vec3;
}

/**
 * Freeze an object graph in place. Arrays, plain objects and their nested
 * values only — a Map's contents cannot be frozen, so `attributesByName` stays
 * readonly by type alone.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
