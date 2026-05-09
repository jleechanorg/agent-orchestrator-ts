import { describe, expect, it } from "vitest";
import { deepMerge, isPlainObject } from "../deep-merge.js";

describe("isPlainObject", () => {
  it("returns true for empty object", () => {
    expect(isPlainObject({})).toBe(true);
  });

  it("returns true for Object.create(null)", () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it("returns false for null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it("returns false for array", () => {
    expect(isPlainObject([])).toBe(false);
  });

  it("returns false for Date", () => {
    expect(isPlainObject(new Date())).toBe(false);
  });

  it("returns false for string", () => {
    expect(isPlainObject("hello")).toBe(false);
  });

  it("returns false for number", () => {
    expect(isPlainObject(42)).toBe(false);
  });
});

describe("deepMerge", () => {
  it("merges flat objects with overlay winning", () => {
    const base = { a: 1, b: 2 };
    const overlay = { b: 3, c: 4 };
    expect(deepMerge(base, overlay)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("recursively merges nested plain objects", () => {
    const base = { config: { a: 1, b: 2 } };
    const overlay = { config: { b: 3, c: 4 } };
    expect(deepMerge(base, overlay)).toEqual({ config: { a: 1, b: 3, c: 4 } });
  });

  it("replaces arrays entirely (no concat)", () => {
    const base = { items: [1, 2, 3] };
    const overlay = { items: [4, 5] };
    expect(deepMerge(base, overlay)).toEqual({ items: [4, 5] });
  });

  it("replaces primitive with object and vice versa", () => {
    const base = { a: "string", b: { nested: true } };
    const overlay = { a: { nested: true }, b: "string" };
    expect(deepMerge(base, overlay)).toEqual({ a: { nested: true }, b: "string" });
  });

  it("handles null overlay values", () => {
    const base = { a: 1, b: 2 };
    const overlay = { b: null };
    expect(deepMerge(base, overlay)).toEqual({ a: 1, b: null });
  });

  it("handles undefined overlay values (treated as atomic)", () => {
    const base = { a: 1, b: 2 };
    const overlay = { b: undefined };
    expect(deepMerge(base, overlay)).toEqual({ a: 1, b: undefined });
  });

  it("deeply merges 3+ levels", () => {
    const base = { l1: { l2: { l3: { a: 1, b: 2 } } } };
    const overlay = { l1: { l2: { l3: { b: 3, c: 4 } } } };
    expect(deepMerge(base, overlay)).toEqual({
      l1: { l2: { l3: { a: 1, b: 3, c: 4 } } },
    });
  });

  it("does not mutate base", () => {
    const base = { a: { b: 1 } };
    const overlay = { a: { c: 2 } };
    const result = deepMerge(base, overlay);
    expect(result).toEqual({ a: { b: 1, c: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
  });
});
