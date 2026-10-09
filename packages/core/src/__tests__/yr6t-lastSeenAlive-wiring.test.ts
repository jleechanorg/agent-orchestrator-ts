// Regression test for jleechan-yr6t: after this fix, on-disk metadata
// reflects a live liveness probe via lastSeenAlive + lastActivityAt
// fields. We test source structure rather than runtime because building
// against a real tmux is out of scope for unit tests.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, ".."));
const TYPES = readFileSync(join(ROOT, "types.ts"), "utf8");
const MGR = readFileSync(join(ROOT, "session-manager.ts"), "utf8");

describe("jleechan-yr6t: SessionMetadata exposes freshness fields", () => {
  it("declares lastActivityAt", () => {
    expect(TYPES).toMatch(/lastActivityAt\?:\s*string/);
  });
  it("declares lastSeenAlive", () => {
    expect(TYPES).toMatch(/lastSeenAlive\?:\s*string/);
  });
});

describe("jleechan-yr6t: enrichSessionWithRuntimeState persists freshness", () => {
  it("persists lastSeenAlive on confirmed-alive path", () => {
    // Find the confirmedAlive branch and assert it persists.
    const m = MGR.match(/if \(confirmedAlive\) \{[\s\S]*?\n {8}\}/);
    expect(m).toBeDefined();
    expect(m![0]).toMatch(/lastSeenAlive/);
    expect(m![0]).toMatch(/updateMetadata/);
  });
  it("persists lastSeenAlive on first isAlive = true", () => {
    // Find the alive = await block and the immediately-following persist.
    const m = MGR.match(/const alive = await aliveRuntime\.isAlive[\s\S]*?if \(alive\) \{[\s\S]*?\n {10}\}/);
    expect(m).toBeDefined();
    expect(m![0]).toMatch(/lastSeenAlive/);
    expect(m![0]).toMatch(/updateMetadata/);
  });
});
