/**
 * plugin-registry-extensions.test.ts
 *
 * Tests for fork-specific plugin registry extensions.
 * This file is fork-specific — upstream uses a no-op module.
 */

import { describe, it, expect } from "vitest";
import { applyForkExtensions } from "../plugin-registry-extensions.js";

describe("applyForkExtensions", () => {
  it("is a no-op that does not throw", () => {
    // Currently a stub — exercises the function without arguments
    expect(() => applyForkExtensions(undefined as never)).not.toThrow();
  });

  it("accepts a PluginRegistry argument without throwing", () => {
    // exercise the function with a mock-like object
    expect(() => applyForkExtensions({} as never)).not.toThrow();
  });
});
