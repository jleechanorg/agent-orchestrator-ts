import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  BACKFILL_MAX_RESPAWNS_PER_PR,
  backfillRespawnNotifiedKey,
  clearPrRespawnCapNotified,
  countArchivedSessionsForPr,
  getPrNumbersAtRespawnCap,
  isPrRespawnCapNotified,
  markPrRespawnCapNotified,
  readProjectPause,
} from "../backfill-respawn-guard.js";
import { getSessionsDir } from "../paths.js";
import {
  GLOBAL_PAUSE_UNTIL_KEY,
  GLOBAL_PAUSE_REASON_KEY,
} from "../global-pause.js";
import type { ProjectConfig } from "../types.js";

let tmpDir: string;
let configPath: string;

function makeProject(): ProjectConfig {
  return {
    name: "app",
    repo: "org/repo",
    path: tmpDir,
    defaultBranch: "main",
    sessionPrefix: "app",
    scm: { plugin: "github" },
    backfillAllPRs: true,
  };
}

function writeOrchestratorPause(untilIso: string, reason = "Model rate limit reached"): void {
  const sessionsDir = getSessionsDir(configPath, tmpDir);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, "app-orchestrator"),
    `status=active\n${GLOBAL_PAUSE_UNTIL_KEY}=${untilIso}\n${GLOBAL_PAUSE_REASON_KEY}=${reason}\n`,
    "utf-8",
  );
}

function writeArchivedPr(sessionId: string, prNumber: number): void {
  const archiveDir = join(getSessionsDir(configPath, tmpDir), "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    join(archiveDir, `${sessionId}_2026-06-08T12-00-00-000Z`),
    `status=killed\npr=https://github.com/org/repo/pull/${prNumber}\n`,
    "utf-8",
  );
}

describe("readProjectPause", () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `ao-backfill-guard-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "# test\n", "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when orchestrator has no active pause", () => {
    expect(readProjectPause(configPath, makeProject())).toBeNull();
  });

  it("returns active pause when orchestrator metadata has future globalPauseUntil", () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    writeOrchestratorPause(until, "Model rate limit detected from app-1");
    const pause = readProjectPause(configPath, makeProject());
    expect(pause).not.toBeNull();
    expect(pause?.until.toISOString()).toBe(until);
    expect(pause?.reason).toContain("Model rate limit");
  });
});

describe("backfill respawn cap", () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `ao-backfill-guard-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "# test\n", "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("counts archived sessions per PR", () => {
    writeArchivedPr("app-99", 654);
    writeArchivedPr("app-98", 654);
    writeArchivedPr("app-97", 123);
    const sessionsDir = getSessionsDir(configPath, tmpDir);
    expect(countArchivedSessionsForPr(sessionsDir, 654)).toBe(2);
    expect(countArchivedSessionsForPr(sessionsDir, 123)).toBe(1);
  });

  it("returns PRs at or above the respawn cap", () => {
    writeArchivedPr("app-1", 654);
    writeArchivedPr("app-2", 654);
    writeArchivedPr("app-3", 654);
    writeArchivedPr("app-4", 654);
    writeArchivedPr("app-5", 654);
    writeArchivedPr("app-6", 654);
    writeArchivedPr("app-7", 123);

    const capped = getPrNumbersAtRespawnCap(getSessionsDir(configPath, tmpDir));
    expect(capped.get(654)).toBe(6);
    expect(capped.has(123)).toBe(false);
    expect(BACKFILL_MAX_RESPAWNS_PER_PR).toBe(6);
  });

  it("tracks one-time Slack escalation markers per PR", () => {
    const sessionsDir = getSessionsDir(configPath, tmpDir);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-orchestrator"), "status=active\n", "utf-8");

    const project = makeProject();
    expect(isPrRespawnCapNotified(configPath, project, 654)).toBe(false);
    markPrRespawnCapNotified(configPath, project, 654);
    expect(isPrRespawnCapNotified(configPath, project, 654)).toBe(true);
    expect(backfillRespawnNotifiedKey(654)).toBe("backfillRespawnNotified_654");
  });

  it("clearPrRespawnCapNotified is a no-op when the marker is already absent", () => {
    const sessionsDir = getSessionsDir(configPath, tmpDir);
    mkdirSync(sessionsDir, { recursive: true });
    const orchestratorPath = join(sessionsDir, "app-orchestrator");
    const originalContent = "status=active\n";
    writeFileSync(orchestratorPath, originalContent, "utf-8");
    const before = statSync(orchestratorPath);

    const project = makeProject();
    // Marker for PR 999 was never set — clear must not rewrite the metadata file.
    clearPrRespawnCapNotified(configPath, project, 999);

    const after = statSync(orchestratorPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(isPrRespawnCapNotified(configPath, project, 999)).toBe(false);
  });

  it("clearPrRespawnCapNotified still clears the marker when present", () => {
    const sessionsDir = getSessionsDir(configPath, tmpDir);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-orchestrator"), "status=active\n", "utf-8");

    const project = makeProject();
    markPrRespawnCapNotified(configPath, project, 654);
    expect(isPrRespawnCapNotified(configPath, project, 654)).toBe(true);
    clearPrRespawnCapNotified(configPath, project, 654);
    expect(isPrRespawnCapNotified(configPath, project, 654)).toBe(false);
  });
});
