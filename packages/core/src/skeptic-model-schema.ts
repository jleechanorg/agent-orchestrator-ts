import { z } from "zod";

export const VALID_SKEPTIC_MODELS = ["codex", "claude", "gemini", "minimax", "agy"] as const;
export type SkepticModel = (typeof VALID_SKEPTIC_MODELS)[number];
export type SkepticModelArray = SkepticModel[];

export const skepticModelEnumSchema = z.enum(VALID_SKEPTIC_MODELS);
export const skepticModelSchema = z.union([
  skepticModelEnumSchema,
  z.array(skepticModelEnumSchema),
]);

export function isValidSkepticModel(model: unknown): model is SkepticModel {
  return typeof model === "string" && (VALID_SKEPTIC_MODELS as readonly string[]).includes(model);
}

/**
 * Shared runtime validator/normalizer.
 * Returns:
 * - Single SkepticModel -> SkepticModel
 * - Array of valid SkepticModels -> SkepticModel[]
 * - Empty array if input is empty array -> []
 * - undefined if invalid or undefined.
 */
export function resolveSkepticModels(raw: unknown): SkepticModel | SkepticModel[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    return raw.filter(isValidSkepticModel);
  }
  return isValidSkepticModel(raw) ? raw : undefined;
}
