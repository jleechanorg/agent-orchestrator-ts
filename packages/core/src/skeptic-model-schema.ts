import { z } from "zod";

export const VALID_SKEPTIC_MODELS = ["codex", "claude", "gemini", "minimax", "agy"] as const;
export type SkepticModel = (typeof VALID_SKEPTIC_MODELS)[number];
export type SkepticModelArray = SkepticModel[];

export const skepticModelEnumSchema = z.enum(VALID_SKEPTIC_MODELS);
export const skepticModelSchema = z.union([
  skepticModelEnumSchema,
  z.array(skepticModelEnumSchema).nonempty(),
]);

export function isValidSkepticModel(model: unknown): model is SkepticModel {
  return typeof model === "string" && (VALID_SKEPTIC_MODELS as readonly string[]).includes(model);
}

/**
 * Shared runtime validator/normalizer.
 * Returns:
 * - Single SkepticModel -> SkepticModel
 * - Array of valid SkepticModels -> SkepticModel[]
 * - undefined if invalid, undefined, or empty.
 */
export function resolveSkepticModels(raw: unknown): SkepticModel | SkepticModel[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const filtered = raw.filter(isValidSkepticModel);
    return filtered.length > 0 ? filtered : undefined;
  }
  return isValidSkepticModel(raw) ? raw : undefined;
}
