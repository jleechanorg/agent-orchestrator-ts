import { describe, it, expect } from "vitest";
import { resolveSkepticModels, skepticModelSchema } from "../skeptic-model-schema.js";
import { resolveSkepticModel } from "../skeptic-models.js";

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

  describe("resolveSkepticModel", () => {
    it("throws if array is empty", () => {
      expect(() => resolveSkepticModel([])).toThrow("options.model must contain at least one model.");
    });

    it("throws if any model is invalid", () => {
      expect(() => resolveSkepticModel(["codex", "invalid" as any])).toThrow(
        "options.model contains invalid model(s); all entries must be valid Skeptic models"
      );
    });

    it("resolves valid models and sets chain", () => {
      const res = resolveSkepticModel(["codex", "claude"]);
      expect(res.validatedModel).toEqual(["codex", "claude"]);
      expect(res.chain).toEqual(["codex", "claude"]);
    });
  });

  describe("skepticModelSchema", () => {
    it("validates single valid model", () => {
      expect(skepticModelSchema.safeParse("codex").success).toBe(true);
    });

    it("validates array of valid models", () => {
      expect(skepticModelSchema.safeParse(["codex", "claude"]).success).toBe(true);
    });

    it("rejects empty arrays", () => {
      expect(skepticModelSchema.safeParse([]).success).toBe(false);
    });

    it("rejects invalid models", () => {
      expect(skepticModelSchema.safeParse("invalid").success).toBe(false);
      expect(skepticModelSchema.safeParse(["codex", "invalid"]).success).toBe(false);
    });
  });
});
