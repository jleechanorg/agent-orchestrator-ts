import { describe, it, expect, vi } from "vitest";
import {
  checkPluginVersionMismatch,
  formatVersionMismatchWarning,
  isCompatibleMajorVersion,
} from "../plugin-version-check.js";

describe("plugin-version-check", () => {
  describe("isCompatibleMajorVersion", () => {
    it("returns true for same major version", () => {
      expect(isCompatibleMajorVersion("1.2.0", "1.5.0")).toBe(true);
    });

    it("returns false for different major version", () => {
      expect(isCompatibleMajorVersion("2.0.0", "1.0.0")).toBe(false);
    });

    it("returns true for same version", () => {
      expect(isCompatibleMajorVersion("0.1.0", "0.1.0")).toBe(true);
    });
  });

  describe("checkPluginVersionMismatch", () => {
    it("returns null when versions match", () => {
      const result = checkPluginVersionMismatch({
        name: "test",
        slot: "agent",
        description: "test",
        version: "0.1.0",
      });
      expect(result).toBeNull();
    });

    it("returns warning when major version differs", () => {
      const result = checkPluginVersionMismatch({
        name: "test",
        slot: "agent",
        description: "test",
        version: "99.0.0",
      });
      expect(result).not.toBeNull();
      expect(result!.pluginName).toBe("test");
    });
  });

  describe("formatVersionMismatchWarning", () => {
    it("includes both versions in message", () => {
      const msg = formatVersionMismatchWarning({
        pluginName: "tmux",
        pluginSlot: "runtime",
        pluginVersion: "2.0.0",
        coreVersion: "1.0.0",
      });
      expect(msg).toContain("2.0.0");
      expect(msg).toContain("1.0.0");
      expect(msg).toContain("tmux");
    });
  });
});
