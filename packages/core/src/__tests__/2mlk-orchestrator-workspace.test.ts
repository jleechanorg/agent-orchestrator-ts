import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(join(process.cwd(), "packages/core/src"));
const MGR = readFileSync(join(ROOT, "session-manager.ts"), "utf8");

describe("jleechan-2mlk: spawnOrchestrator uses the workspace plugin", () => {
  it("declares let workspacePath inside spawnOrchestrator", () => {
    // The variable is declared with `let workspacePath` (not `const project.path`).
    // Find the function body and check the declaration exists.
    const fn = MGR.match(/async function spawnOrchestrator[\s\S]*?\n  \}\n/);
    assert.ok(fn, "spawnOrchestrator function not found");
    assert.match(fn![0], /let workspacePath/);
  });
  it("invokes the workspace plugin before runtime.create", () => {
    const fn = MGR.match(/async function spawnOrchestrator[\s\S]*?\n  \}\n/)![0];
    assert.match(fn, /if \(plugins\.workspace\)/);
    assert.match(fn, /plugins\.workspace\.create/);
    assert.match(fn, /plugins\.workspace\.findManagedWorkspace/);
  });
  it("uses the plugin-managed path in runtime.create", () => {
    const fn = MGR.match(/async function spawnOrchestrator[\s\S]*?\n  \}\n/)![0];
    // After the patch, runtime.create uses `workspacePath` (the plugin-managed
    // var) instead of `project.path` hardcoded.
    assert.match(fn, /workspacePath,\s*\/\/ jleechan-2mlk/);
    assert.doesNotMatch(fn, /workspacePath:\s*project\.path,\s*launchCommand/);
  });
  it("falls back to project.path on plugin failure", () => {
    const fn = MGR.match(/async function spawnOrchestrator[\s\S]*?\n  \}\n/)![0];
    assert.match(fn, /catch \(err\)/);
    // The let workspacePath default keeps the original path on failure.
    assert.match(fn, /let workspacePath = project\.path/);
  });
});
