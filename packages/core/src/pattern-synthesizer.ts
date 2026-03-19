import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export interface SynthesizedPattern {
  trigger: string;
  bestAction: string;
  winRate: number;
  sampleCount: number;
  avgDurationMs: number;
  confidence: "high" | "medium" | "low";
}

export interface PatternStore {
  patterns: SynthesizedPattern[];
  synthesizedAt: string;
  outcomeCount: number;
}

interface OutcomeRecord {
  trigger: string;
  action: string;
  success: boolean;
  durationMs?: number;
  projectId?: string;
}

interface PatternSynthesizerOptions {
  outcomesPath: string;
  patternsPath: string;
  minSamples?: number;
  confidenceThreshold?: number;
}

function isOutcomeRecord(value: unknown): value is OutcomeRecord {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.trigger === "string" &&
    typeof obj.action === "string" &&
    typeof obj.success === "boolean" &&
    (obj.projectId === undefined || typeof obj.projectId === "string")
  );
}

function assignConfidence(
  winRate: number,
  thresholds: { high: number; medium: number },
): "high" | "medium" | "low" {
  if (winRate >= thresholds.high) return "high";
  if (winRate >= thresholds.medium) return "medium";
  return "low";
}

export class PatternSynthesizer {
  private readonly outcomesPath: string;
  private readonly patternsPath: string;
  private readonly minSamples: number;
  private readonly confidenceThreshold: { high: number; medium: number };

  constructor(options: PatternSynthesizerOptions) {
    this.outcomesPath = options.outcomesPath;
    this.patternsPath = options.patternsPath;
    this.minSamples = options.minSamples ?? 5;
    const ct = options.confidenceThreshold ?? 0.8;
    this.confidenceThreshold = { high: ct, medium: ct * 0.625 };
  }

  async synthesize(): Promise<void> {
    const outcomes = this.readOutcomes();
    if (outcomes.length === 0) {
      this.writeStore({ patterns: [], synthesizedAt: new Date().toISOString(), outcomeCount: 0 });
      return;
    }

    // Group by projectId::trigger → action
    const groups = new Map<string, Map<string, OutcomeRecord[]>>();
    for (const o of outcomes) {
      const groupKey = `${o.projectId ?? "default"}::${o.trigger}`;
      let actionMap = groups.get(groupKey);
      if (!actionMap) {
        actionMap = new Map();
        groups.set(groupKey, actionMap);
      }
      let list = actionMap.get(o.action);
      if (!list) {
        list = [];
        actionMap.set(o.action, list);
      }
      list.push(o);
    }

    const patterns: SynthesizedPattern[] = [];

    for (const [groupKey, actionMap] of groups) {
      const trigger = groupKey.includes("::") ? groupKey.split("::").slice(1).join("::") : groupKey;
      let bestAction: string | null = null;
      let bestWinRate = -1;
      let bestSampleCount = 0;
      let bestAvgDuration = 0;

      for (const [action, records] of actionMap) {
        if (records.length < this.minSamples) continue;

        const successes = records.filter((r) => r.success);
        const winRate = successes.length / records.length;

        if (winRate > bestWinRate) {
          bestWinRate = winRate;
          bestAction = action;
          bestSampleCount = records.length;

          const durations = successes
            .map((r) => r.durationMs)
            .filter((d): d is number => typeof d === "number");
          bestAvgDuration =
            durations.length > 0
              ? durations.reduce((a, b) => a + b, 0) / durations.length
              : 0;
        }
      }

      if (bestAction !== null) {
        patterns.push({
          trigger,
          bestAction,
          winRate: bestWinRate,
          sampleCount: bestSampleCount,
          avgDurationMs: bestAvgDuration,
          confidence: assignConfidence(bestWinRate, this.confidenceThreshold),
        });
      }
    }

    this.writeStore({
      patterns,
      synthesizedAt: new Date().toISOString(),
      outcomeCount: outcomes.length,
    });
  }

  async getPattern(trigger: string): Promise<SynthesizedPattern | null> {
    const store = this.readStore();
    if (!store) return null;
    return store.patterns.find((p) => p.trigger === trigger) ?? null;
  }

  async getAllPatterns(): Promise<SynthesizedPattern[]> {
    const store = this.readStore();
    if (!store) return [];
    return store.patterns;
  }

  async getBestStrategy(trigger: string): Promise<string | null> {
    const pattern = await this.getPattern(trigger);
    return pattern ? pattern.bestAction : null;
  }

  private readOutcomes(): OutcomeRecord[] {
    if (!existsSync(this.outcomesPath)) return [];

    const content = readFileSync(this.outcomesPath, "utf-8");
    const results: OutcomeRecord[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isOutcomeRecord(parsed)) {
          results.push(parsed);
        }
      } catch {
        // skip invalid lines
      }
    }

    return results;
  }

  private readStore(): PatternStore | null {
    if (!existsSync(this.patternsPath)) return null;
    try {
      const content = readFileSync(this.patternsPath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "patterns" in parsed &&
        Array.isArray((parsed as Record<string, unknown>).patterns)
      ) {
        const obj = parsed as Record<string, unknown>;
        const patterns = obj.patterns as unknown[];
        const valid = patterns.every(
          (p) =>
            typeof p === "object" &&
            p !== null &&
            typeof (p as Record<string, unknown>).trigger === "string" &&
            typeof (p as Record<string, unknown>).bestAction === "string" &&
            typeof (p as Record<string, unknown>).winRate === "number",
        );
        if (!valid) return null;
        return parsed as PatternStore;
      }
      return null;
    } catch {
      return null;
    }
  }

  private writeStore(store: PatternStore): void {
    mkdirSync(dirname(this.patternsPath), { recursive: true });
    atomicWriteFileSync(this.patternsPath, JSON.stringify(store, null, 2));
  }
}
