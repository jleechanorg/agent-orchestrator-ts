/**
 * ci-doctor-gate.test.ts — Structural guard for the ao-doctor-v2 CI gate (bd-1sno)
 *
 * Locks in the 2026-06-10 staging-config regression class: if a future PR
 * removes or weakens the `ao-doctor-v2` job in `.github/workflows/ci.yml`,
 * this test fails the wholesome CI gate.
 *
 * The test reads `.github/workflows/ci.yml` as plain text and asserts the
 * presence of the new job. We use a structural assertion (not a behavioral
 * one) because we cannot easily run a real GHA workflow inside a Vitest
 * unit test — the assertion is a Red-Green gate that a future PR cannot
 * silently delete the doctor job.
 *
 * Acceptance (Red→Green):
 *   - Red:  test fails on `main` @ 37ff31cda (no `ao-doctor-v2` job exists).
 *   - Green: test passes after the new `ao-doctor-v2` job is added.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// REPO_ROOT is 4 levels up from this test file (packages/core/src/__tests__/).
function computeRepoRoot(): string {
  const candidate = import.meta.dirname
    ? join(import.meta.dirname, "..", "..", "..", "..")
    : join(process.cwd());
  if (!existsSync(join(candidate, ".git"))) {
    throw new Error(`REPO_ROOT=${candidate} is not a git repo (no .git found)`);
  }
  return candidate;
}
const REPO_ROOT = computeRepoRoot();

const CI_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const DOCTOR_SCRIPT_PATH = join(REPO_ROOT, "scripts", "ao-doctor-v2.sh");

describe("ci-doctor-gate — bd-1sno: ao-doctor-v2 wired into ci.yml", () => {
  it("the doctor script and the CI workflow both exist on disk", () => {
    // Pre-condition: both files must exist before we test their relationship.
    expect(existsSync(DOCTOR_SCRIPT_PATH), `missing doctor script: ${DOCTOR_SCRIPT_PATH}`).toBe(true);
    expect(existsSync(CI_WORKFLOW_PATH), `missing ci workflow: ${CI_WORKFLOW_PATH}`).toBe(true);
    // Sanity: both files must be non-empty.
    expect(statSync(DOCTOR_SCRIPT_PATH).size, "doctor script is empty").toBeGreaterThan(0);
    expect(statSync(CI_WORKFLOW_PATH).size, "ci.yml is empty").toBeGreaterThan(0);
  });

  it("ci.yml defines an ao-doctor-v2 job that runs scripts/ao-doctor-v2.sh", () => {
    const ci = readFileSync(CI_WORKFLOW_PATH, "utf-8");

    // The new job must be present by name.
    expect(ci, "ci.yml must define an `ao-doctor-v2:` job (bd-1sno)").toMatch(
      /^\s*ao-doctor-v2\s*:/m,
    );

    // The job must run on pull_request events (PRs are the merge gate).
    // We accept any runner selection (ubuntu-latest OR self-hosted labels).
    const jobBlockMatch = ci.match(/^\s*ao-doctor-v2\s*:\s*\n([\s\S]*?)(?=^\s{0,2}\w[\w-]*\s*:\s*$|\Z)/m);
    expect(jobBlockMatch, "could not isolate the ao-doctor-v2 job block").not.toBeNull();
    const jobBlock = jobBlockMatch?.[1] ?? "";

    // The job must actually invoke the doctor script (not just be named).
    expect(jobBlock, "ao-doctor-v2 job must invoke scripts/ao-doctor-v2.sh").toContain(
      "scripts/ao-doctor-v2.sh",
    );

    // The job must run on PRs (pull_request trigger is set on the workflow,
    // but we also accept workflow_dispatch to allow manual rescue reruns).
    // The trigger is declared at workflow level, so we just verify the
    // workflow still has pull_request enabled.
    expect(ci, "ci.yml must keep pull_request trigger enabled").toMatch(
      /^\s*pull_request\s*:/m,
    );
  });

  it("ao-doctor-v2 job is required before the merge-decision gate (no continue-on-error / no soft fail)", () => {
    const ci = readFileSync(CI_WORKFLOW_PATH, "utf-8");

    // The job block must NOT use continue-on-error (otherwise a doctor
    // failure would not block merges).
    const jobBlockMatch = ci.match(/^\s*ao-doctor-v2\s*:\s*\n([\s\S]*?)(?=^\s{0,2}\w[\w-]*\s*:\s*$|\Z)/m);
    expect(jobBlockMatch, "could not isolate the ao-doctor-v2 job block").not.toBeNull();
    const jobBlock = jobBlockMatch?.[1] ?? "";

    expect(
      jobBlock,
      "ao-doctor-v2 job must not use continue-on-error (would weaken the gate)",
    ).not.toMatch(/continue-on-error\s*:\s*true/);

    // Doctor script exits non-zero on FAIL — by default GitHub Actions
    // marks the job FAILED when any step exits non-zero, so no `if: always()`
    // or `continue-on-error` is needed. We also verify the job uses the
    // default `fail-fast` by not declaring `continue-on-error` on the
    // invocation step either.
    const stepMatches = jobBlock.match(/^\s{4,}-\s+run\s*:[\s\S]*?(?=\n\s{4,}-\s+|\Z)/gm) ?? [];
    for (const step of stepMatches) {
      expect(
        step,
        "step that runs ao-doctor-v2 must not have continue-on-error: true",
      ).not.toMatch(/continue-on-error\s*:\s*true/);
    }
  });

  it("the doctor script itself is a valid executable that exits non-zero on synthetic regression", () => {
    // Behavioral check: run the doctor script with a synthetic staging
    // config that has no `scm:` field, and confirm it exits non-zero.
    // This proves the CI gate would actually catch the regression class.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const os = require("node:os") as typeof import("node:os");
    const fs = require("node:fs") as typeof import("node:fs");

    const tmpDir = fs.mkdtempSync(join(os.tmpdir(), "doctor-test-"));
    const fakeCfg = join(tmpDir, "agent-orchestrator.yaml");
    // Empty config — has `projects:` map with no `scm:` keys. This is
    // the exact shape of the 2026-06-10 regression.
    fs.writeFileSync(
      fakeCfg,
      "projects:\n  alpha:\n    tracker: github\n  beta:\n    tracker: github\n",
    );

    try {
      let exitCode = -1;
      let stdout = "";
      try {
        stdout = execFileSync("bash", [DOCTOR_SCRIPT_PATH], {
          cwd: REPO_ROOT,
          env: { ...process.env, HERMES_STAGING_CONFIG: fakeCfg },
          encoding: "utf-8",
        });
      } catch (err: unknown) {
        // execFileSync throws on non-zero exit. Capture the code and
        // partial output for the assertion message.
        const e = err as { status?: number | null; stdout?: string };
        exitCode = e.status ?? -1;
        stdout = e.stdout ?? "";
      }
      // exitCode will be 0 only if the doctor somehow passed. We expect
      // a non-zero exit because the synthetic config has no scm: field
      // but defines 2 projects — doctor should FAIL check 1.
      expect(
        exitCode,
        `doctor should exit non-zero on synthetic scm regression; got ${exitCode}\nstdout:\n${stdout}`,
      ).not.toBe(0);
      expect(stdout, "doctor stdout should mention scm regression").toMatch(/scm/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
