/**
 * plugin-registry-fallback.test.ts
 *
 * Tests for the monorepo fallback resolution logic in plugin-registry-fallback.ts.
 * This file is fork-specific — upstream uses a different package resolution strategy.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  isPackageResolutionFailure,
  tryMonorepoFallback,
} from "../plugin-registry-fallback.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// isPackageResolutionFailure
// ---------------------------------------------------------------------------

describe("isPackageResolutionFailure", () => {
  it("returns false when err is null", () => {
    expect(isPackageResolutionFailure(null, "some-pkg")).toBe(false);
  });

  it("returns false when err is a primitive", () => {
    expect(isPackageResolutionFailure("not an object", "some-pkg")).toBe(false);
  });

  it("returns false when MODULE_NOT_FOUND but package name not in message", () => {
    const err = new Error("something else") as NodeJS.ErrnoException;
    err.code = "MODULE_NOT_FOUND";
    expect(isPackageResolutionFailure(err, "some-pkg")).toBe(false);
  });

  it("returns true when MODULE_NOT_FOUND and package name in message", () => {
    const err = new Error("cannot find module 'some-pkg'") as NodeJS.ErrnoException;
    err.code = "MODULE_NOT_FOUND";
    expect(isPackageResolutionFailure(err, "some-pkg")).toBe(true);
  });

  it("returns true when ERR_MODULE_NOT_FOUND and package name in message", () => {
    const err = new Error("Error loading module @jleechanorg/ao-plugin-gemini") as NodeJS.ErrnoException;
    err.code = "ERR_MODULE_NOT_FOUND";
    expect(isPackageResolutionFailure(err, "@jleechanorg/ao-plugin-gemini")).toBe(true);
  });

  it("returns true for 'cannot find package' message", () => {
    const err = new Error("cannot find package '@jleechanorg/ao-plugin-minimax'") as NodeJS.ErrnoException;
    err.code = undefined;
    expect(isPackageResolutionFailure(err, "@jleechanorg/ao-plugin-minimax")).toBe(true);
  });

  it("returns true for 'cannot find module' message (case insensitive)", () => {
    const err = new Error("CANNOT FIND MODULE something") as NodeJS.ErrnoException;
    err.code = undefined;
    expect(isPackageResolutionFailure(err, "something")).toBe(true);
  });

  it("returns true for 'Not found: <pkg>' message", () => {
    const err = new Error("Not found: @jleechanorg/ao-plugin-gemini") as NodeJS.ErrnoException;
    err.code = undefined;
    expect(isPackageResolutionFailure(err, "@jleechanorg/ao-plugin-gemini")).toBe(true);
  });

  it("returns false when package name not in message even with code", () => {
    const err = new Error("some other error") as NodeJS.ErrnoException;
    err.code = "MODULE_NOT_FOUND";
    expect(isPackageResolutionFailure(err, "my-pkg")).toBe(false);
  });

  it("returns false when message has package but no relevant code or pattern", () => {
    const err = new Error("something about my-pkg here") as NodeJS.ErrnoException;
    err.code = undefined;
    expect(isPackageResolutionFailure(err, "my-pkg")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tryMonorepoFallback
// ---------------------------------------------------------------------------

describe("tryMonorepoFallback", () => {
  // Use the current file's URL as modUrl — a real file URL inside packages/core/dist/
  const distModUrl = pathToFileURL(join(__dirname, "../../dist/plugin-registry.js")).href;

  it("returns null for non-jleechanorg packages", async () => {
    const result = await tryMonorepoFallback("some-random-package", distModUrl);
    expect(result).toBeNull();
  });

  it("returns null for non-plugin jleechanorg packages", async () => {
    const result = await tryMonorepoFallback("@jleechanorg/other-package", distModUrl);
    expect(result).toBeNull();
  });

  it("returns null when monorepo path does not exist", async () => {
    // Use a modUrl that points to a non-existent location
    const fakeModUrl = "file:///nonexistent/path/dist/plugin-registry.js";
    const result = await tryMonorepoFallback("@jleechanorg/ao-plugin-gemini", fakeModUrl);
    expect(result).toBeNull();
  });

  it("returns null when plugin dist does not exist", async () => {
    // Use the real dist URL but a plugin name that doesn't exist in monorepo
    const result = await tryMonorepoFallback("@jleechanorg/ao-plugin-nonexistent-plugin-xyz", distModUrl);
    expect(result).toBeNull();
  });
});
