import { createHash } from "node:crypto";
import type {
  CanonicalPRReason,
  CanonicalPRState,
  CanonicalSessionReason,
  CanonicalSessionState,
  SessionStatus,
} from "./types.js";

export interface LifecycleDecision {
  status: SessionStatus;
  evidence: string;
  detecting: {
    attempts: number;
    startedAt?: string;
    evidenceHash?: string;
  };
  sessionState?: CanonicalSessionState;
  sessionReason?: CanonicalSessionReason;
  prState?: CanonicalPRState;
  prReason?: CanonicalPRReason;
}

export const DETECTING_MAX_ATTEMPTS = 3;
export const DETECTING_MAX_DURATION_MS = 5 * 60 * 1000;

export function isDetectingTimedOut(
  detectingStartedAt: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!detectingStartedAt) return false;
  const startedAt = Date.parse(detectingStartedAt);
  if (Number.isNaN(startedAt)) return false;
  return now.getTime() - startedAt > DETECTING_MAX_DURATION_MS;
}

export function parseAttemptCount(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeEvidenceForHash(evidence: string): string {
  return evidence
    .replace(/\sactivity=[^\s]+/g, "")
    .replace(/\sat=[^\s]+/g, "")
    .trim();
}

export function hashEvidence(evidence: string): string {
  return createHash("sha256")
    .update(normalizeEvidenceForHash(evidence))
    .digest("hex")
    .slice(0, 12);
}
