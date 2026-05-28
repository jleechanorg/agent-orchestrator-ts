import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSpawnLock } from "../spawn-guard.js";

describe("spawn-guard", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spawn-guard-test-"));
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "defaults: {}\nprojects: {}", "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquires lock when no existing lock", () => {
    const result = acquireSpawnLock(configPath, tmpDir);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      result.release();
    }
  });

  it("blocks second acquire from same process", () => {
    const first = acquireSpawnLock(configPath, tmpDir);
    expect(first.acquired).toBe(true);

    const second = acquireSpawnLock(configPath, tmpDir);
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.blockingPid).toBe(process.pid);
    }

    if (first.acquired) first.release();
  });

  it("allows acquire after release", () => {
    const first = acquireSpawnLock(configPath, tmpDir);
    expect(first.acquired).toBe(true);
    if (first.acquired) first.release();

    const second = acquireSpawnLock(configPath, tmpDir);
    expect(second.acquired).toBe(true);
    if (second.acquired) second.release();
  });

  it("allows acquire for different project paths", () => {
    const projA = join(tmpDir, "project-a");
    const projB = join(tmpDir, "project-b");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    const first = acquireSpawnLock(configPath, projA);
    expect(first.acquired).toBe(true);

    const second = acquireSpawnLock(configPath, projB);
    expect(second.acquired).toBe(true);

    if (first.acquired) first.release();
    if (second.acquired) second.release();
  });

  it("release is idempotent", () => {
    const result = acquireSpawnLock(configPath, tmpDir);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      result.release();
      result.release();
    }
  });
});
