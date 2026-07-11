import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MGR = readFileSync(join(ROOT, "session-manager.ts"), "utf8");

describe("jleechan-2mlk: spawnOrchestrator uses the workspace plugin", () => {
  it("declares let workspacePath inside spawnOrchestrator", () => {
    // The variable is declared with `let workspacePath` (not `const project.path`).
    // Find the function body and check the declaration exists.
    const fn = MGR.match(/async function spawnOrchestrator[\s\S]*?\n {2}\}\n/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/let workspacePath/);
  });
  it("invokes the workspace plugin before runtime.create", () => {
    const fn = MGR.match(/async function spawnOrchestrator[\s\S]*?\n {2}\}\n/)![0];
    expect(fn).toMatch(/if \(plugins\.workspace\)/);
    expect(fn).toMatch(/plugins\.workspace\.create/);
    expect(fn).toMatch(/plugins\.workspace\.findManagedWorkspace/);
  });
  it("uses the plugin-managed path in runtime.create", () => {
    const fn = MGR.match(/async function spawnOrchestrator[\s\S]*?\n {2}\}\n/)![0];
    // After the patch, runtime.create uses `workspacePath` (the plugin-managed
    // var) instead of `project.path` hardcoded.
    expect(fn).toMatch(/workspacePath,\s*\/\/ jleechan-2mlk/);
    expect(fn).not.toMatch(/workspacePath:\s*project\.path,\s*launchCommand/);
  });
  it("falls back to project.path on plugin failure", () => {
    const fn = MGR.match(/async function spawnOrchestrator[\s\S]*?\n {2}\}\n/)![0];
    expect(fn).toMatch(/catch \(err\)/);
    // The let workspacePath default keeps the original path on failure.
    expect(fn).toMatch(/let workspacePath = project\.path/);
  });
});
