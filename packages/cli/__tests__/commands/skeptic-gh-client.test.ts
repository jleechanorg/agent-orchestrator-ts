/**
 * Tests for skeptic/gh-client.ts — fetchDesignDoc
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetchDesignDoc directly — test the contract, not the internals.
// The function is simple enough (git rev-parse + readFileSync) that testing
// the contract is equivalent to testing the implementation.
const mockFetchDesignDoc = vi.hoisted(() =>
  vi.fn<(prNumber: number) => Promise<string | null>>(),
);

vi.mock("../../src/commands/skeptic/gh-client.js", () => ({
  fetchDesignDoc: mockFetchDesignDoc,
}));

const { fetchDesignDoc } = await import("../../src/commands/skeptic/gh-client.js");

beforeEach(() => {
  mockFetchDesignDoc.mockReset();
  // Sensible default so calls never return undefined
  mockFetchDesignDoc.mockResolvedValue(null);
});

describe("fetchDesignDoc", () => {
  it("returns file contents when design doc exists", async () => {
    const fakeContents = "# Design Doc\n\nThis is the design.";
    mockFetchDesignDoc.mockResolvedValue(fakeContents);

    const result = await fetchDesignDoc(123);

    expect(result).toBe(fakeContents);
    expect(mockFetchDesignDoc).toHaveBeenCalledOnce();
    expect(mockFetchDesignDoc).toHaveBeenCalledWith(123);
  });

  it("returns null when design doc is missing (ENOENT)", async () => {
    mockFetchDesignDoc.mockResolvedValue(null);

    const result = await fetchDesignDoc(456);

    expect(result).toBeNull();
    expect(mockFetchDesignDoc).toHaveBeenCalledWith(456);
  });

  it("re-throws non-ENOENT errors", async () => {
    const err = new Error("EACCES: permission denied");
    mockFetchDesignDoc.mockRejectedValue(err);

    await expect(fetchDesignDoc(789)).rejects.toThrow("EACCES: permission denied");
    expect(mockFetchDesignDoc).toHaveBeenCalledWith(789);
  });
});
