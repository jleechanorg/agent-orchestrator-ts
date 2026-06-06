import { describe, it, expect } from "vitest";
import { resolveSkepticModels, skepticModelSchema } from "../skeptic-model-schema.js";

describe("skeptic-model-schema", () => {
  describe("resolveSkepticModels", () => {
    it("resolves undefined to undefined", () => {
      expect(resolveSkepticModels(undefined)).toBeUndefined();
    });

    it("resolves single valid model to string", () => {
      expect(resolveSkepticModels("codex")).toBe("codex");
      expect(resolveSkepticModels("claude")).toBe("claude");
    });

    it("resolves invalid single model to undefined", () => {
      expect(resolveSkepticModels("invalid")).toBeUndefined();
    });

    it("resolves empty array to empty array", () => {
      expect(resolveSkepticModels([])).toEqual([]);
    });

    it("resolves array of valid models", () => {
      expect(resolveSkepticModels(["codex", "claude"])).toEqual(["codex", "claude"]);
    });

    it("filters out invalid models in array", () => {
      expect(resolveSkepticModels(["codex", "invalid", "claude"])).toEqual(["codex", "claude"]);
    });
  });

  describe("skepticModelSchema", () => {
    it("validates single valid model", () => {
      expect(skepticModelSchema.safeParse("codex").success).toBe(true);
    });

    it("validates array of valid models", () => {
      expect(skepticModelSchema.safeParse(["codex", "claude"]).success).toBe(true);
    });

    it("rejects invalid models", () => {
      expect(skepticModelSchema.safeParse("invalid").success).toBe(false);
      expect(skepticModelSchema.safeParse(["codex", "invalid"]).success).toBe(false);
    });
  });
});
