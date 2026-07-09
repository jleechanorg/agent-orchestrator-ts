// Regression test for jleechan-yr6t: after this fix, on-disk metadata
// reflects a live liveness probe via lastSeenAlive + lastActivityAt
// fields. We test source structure rather than runtime because building
// against a real tmux is out of scope for unit tests.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(join(process.cwd(), "packages/core/src"));
const TYPES = readFileSync(join(ROOT, "types.ts"), "utf8");
const MGR = readFileSync(join(ROOT, "session-manager.ts"), "utf8");

describe("jleechan-yr6t: SessionMetadata exposes freshness fields", () => {
  it("declares lastActivityAt", () => {
    assert.match(TYPES, /lastActivityAt\?:\s*string/);
  });
  it("declares lastSeenAlive", () => {
    assert.match(TYPES, /lastSeenAlive\?:\s*string/);
  });
});

describe("jleechan-yr6t: enrichSessionWithRuntimeState persists freshness", () => {
  it("persists lastSeenAlive on confirmed-alive path", () => {
    // Find the confirmedAlive branch and assert it persists.
    const m = MGR.match(/if \(confirmedAlive\) \{[\s\S]*?\n        \}/);
    assert.ok(m, "confirmedAlive branch not found");
    assert.match(m![0], /lastSeenAlive/);
    assert.match(m![0], /updateMetadata/);
  });
  it("persists lastSeenAlive on first isAlive = true", () => {
    // Find the alive = await block and the immediately-following persist.
    const m = MGR.match(/const alive = await aliveRuntime\.isAlive[\s\S]*?if \(alive\) \{[\s\S]*?\n          \}/);
    assert.ok(m, "first-alive block not found");
    assert.match(m![0], /lastSeenAlive/);
    assert.match(m![0], /updateMetadata/);
  });
});
