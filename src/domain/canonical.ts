import { createHash } from "node:crypto";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalizeValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical data cannot contain non-finite numbers");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        output[key] = canonicalizeValue(item);
      }
    }
    return output;
  }

  throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
}

export function canonicalize(value: unknown): CanonicalValue {
  return canonicalizeValue(value);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}
