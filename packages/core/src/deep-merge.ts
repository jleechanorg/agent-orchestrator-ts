/**
 * Deep merge utility for config overlay.
 *
 * Rules:
 * - Plain objects: recurse (overlay keys win on conflict)
 * - Arrays: overlay replaces base entirely (no concat)
 * - Primitives / null / undefined: overlay wins
 *
 * "Plain object" = `{}` created via `new Object()`, `{}`, or `Object.create(null)`.
 * Arrays, Dates, RegExps, class instances are treated as atomic values.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === null) {
    return true;
  }
  return proto === Object.prototype;
}

export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overlay: Record<string, unknown>,
): T {
  const result = { ...base } as Record<string, unknown>;

  for (const key of Object.keys(overlay)) {
    const baseVal = result[key];
    const overVal = (overlay as Record<string, unknown>)[key];

    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      );
    } else {
      result[key] = overVal;
    }
  }

  return result as T;
}
