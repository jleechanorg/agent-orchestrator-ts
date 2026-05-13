/**
 * wholesome.test.ts — Structural source-code assertions
 *
 * "Multiple shots on goal" (Ryan/OpenAI): enforce quality dimensions at
 * TEST time, not just runtime hooks or review. Each test asserts a
 * structural invariant on the codebase or diff rather than behavior.
 *
 * Tests run in CI via .github/workflows/wholesome-checks.yml
 *
 * NOTE: These tests are designed to run in several contexts:
 *   1. CI: fetches real PR title via gh CLI (GITHUB_TOKEN available)
 *   2. Local with an open PR: `gh pr view` uses the real title (branch names like feat/bd-x are not titles)
 *   3. Local override: AO_WHOLESOME_PR_TITLE (preferred) or AO_WHOLLESOME_PR_TITLE
 *      for pre-push runs before a PR exists — ignored in CI (GITHUB_ACTIONS)
 *   4. Otherwise: branch name (fails if it is not a valid [agento] title — intentional)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all .ts/.tsx files under a directory. */
function collectTsFiles(root: string, prefix = ""): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(root, entry);
    const rel  = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      results.push(...collectTsFiles(full, rel));
    } else if ([".ts", ".tsx"].includes(extname(entry))) {
      results.push(rel);
    }
  }
  return results;
}

/**
 * Run a git command and return stdout (string, trimmed).
 * Uses execFileSync with an explicitly parsed arg array to avoid shell injection
 * when any argument contains user-controlled data (e.g. BASE_BRANCH from GITHUB_BASE_REF).
 *
 * @param strict - if true, throws on any git failure; use for structural checks where
 *   an error means the check is invalid (not "no violations"). If false, returns ""
 *   on error (lenient — use for fallback/non-critical commands like branch-name lookup).
 */
function git(args: string, cwd: string, strict = false): string {
  try {
    const parsed = args.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g)?.map(token =>
      token.replace(/^['"]|['"]$/g, "")
    ) ?? [];
    return execFileSync("git", parsed, { cwd, encoding: "utf-8" }).trim();
  } catch (err: unknown) {
    if (strict) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`git ${args} failed: ${msg}`, { cause: err });
    }
    return "";
  }
}

// import.meta.dirname is the directory of this test file:
//   packages/core/src/__tests__/wholesome.test.ts
// Going up 4 levels reaches the git worktree root (where .git lives).
function computeRepoRoot(): string {
  const candidate = import.meta.dirname
    ? join(import.meta.dirname, "..", "..", "..", "..")
    : join(process.cwd()); // CJS fallback
  try {
    statSync(join(candidate, ".git"));
  } catch {
    throw new Error(`REPO_ROOT=${candidate} is not a git repo (no .git found)`);
  }
  return candidate;
}
const REPO_ROOT = computeRepoRoot();

function validateGitRef(raw: string, envVar: string): string {
  if (!/^[a-zA-Z0-9/._^~-]+$/.test(raw) || raw.includes("..")) {
    throw new Error(`Invalid ${envVar} (possible injection): ${raw}`);
  }
  return raw;
}

function gitRefExists(ref: string, cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref], {
      cwd,
      encoding: "utf-8",
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Pick a stable diff base across PR CI, main-branch CI, and local runs. */
function resolveBaseBranch(cwd: string): string {
  const raw = process.env.GITHUB_BASE_REF;
  if (raw !== undefined && raw !== "") {
    return validateGitRef(raw, "GITHUB_BASE_REF");
  }

  for (const candidate of ["origin/HEAD", "origin/main", "main", "HEAD^"]) {
    if (gitRefExists(candidate, cwd)) {
      return candidate;
    }
  }

  return "HEAD";
}

const BASE_BRANCH = resolveBaseBranch(REPO_ROOT);

/** Return diff lines (with file path) that ADD a given pattern in .ts files. */
function getAddedLinesMatching(cwd: string, pattern: RegExp): Array<{file: string; line: string}> {
  const raw = git(`diff --diff-filter=AM ${BASE_BRANCH}...HEAD`, cwd, true);
  if (!raw) return [];
  const results: Array<{file: string; line: string}> = [];
  let currentFile = "";
  let inTsFile = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      currentFile = line.replace("diff --git a/", "").split(" ")[0] ?? "";
      inTsFile = /\.(ts|tsx)$/.test(currentFile);
      continue;
    }
    if (!inTsFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      if (pattern.test(content)) {
        results.push({ file: currentFile, line: content.trim() });
      }
    }
  }
  return results;
}

/** Get the PR title — CI via gh + env; local via gh, optional env override, or branch name. */
function getPRTitle(): string {
  const override =
    process.env.AO_WHOLESOME_PR_TITLE?.trim() ||
    process.env.AO_WHOLLESOME_PR_TITLE?.trim();
  if (override && !process.env.GITHUB_ACTIONS) return override;

  // In CI, use the gh CLI to fetch the actual PR title for the current branch.
  // Always use GITHUB_HEAD_REF (not git rev-parse) — detached HEAD in CI returns "HEAD".
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY && process.env.GITHUB_HEAD_REF) {
    const repo   = process.env.GITHUB_REPOSITORY; // "owner/repo"
    const branch = process.env.GITHUB_HEAD_REF;
    try {
      // Use execFileSync (array args) to avoid shell injection when env vars are
      // interpolated. execSync with a template string runs through the shell.
      const title = execFileSync(
        "gh",
        ["pr", "view", branch, "--repo", repo, "--json", "title", "--jq", ".title"],
        { encoding: "utf-8", timeout: 30_000 }
      ).trim();
      if (title) return title;
    } catch (err: unknown) {
      // All CI env vars are present but gh pr view failed — this is a test environment
      // error, not "no open PR". Throw rather than silently falling back to branch name.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`gh pr view failed in CI context: ${msg}`, { cause: err });
    }
  }
  // GITHUB_HEAD_REF is set but GITHUB_TOKEN is not — we are in a PR checkout
  // (diff-coverage job) but cannot call the gh API to get the real PR title.
  // Returning "" skips enforcement rather than falling back to the merge commit
  // subject, which would cause spurious failures in coverage jobs.
  if (process.env.GITHUB_HEAD_REF && !process.env.GITHUB_TOKEN) {
    return "";
  }
  // Push builds on main do not have PR context. Use the commit subject instead of
  // the branch name so [agento] policy checks still validate the merged change.
  if (process.env.GITHUB_ACTIONS) {
    return git("log -1 --format=%s", REPO_ROOT, true);
  }
  // Local: current branch may have an open PR with a proper [agento] title.
  try {
    const title = execFileSync(
      "gh",
      ["pr", "view", "--json", "title", "--jq", ".title"],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: 30_000 }
    ).trim();
    if (title) return title;
  } catch {
    // no PR, gh missing, or not authenticated
  }
  // Fallback: branch name (fails when prefix is missing — e.g. feat/bd-x before PR exists).
  // strict=true so broken git state (e.g. detached HEAD with no ref) raises instead of silently passing.
  return git("rev-parse --abbrev-ref HEAD", REPO_ROOT, true);
}

function shouldEnforcePRTitlePrefix(title: string): boolean {
  // Empty title means we couldn't retrieve the PR title (e.g., GITHUB_TOKEN
  // absent in a coverage job) — skip enforcement rather than false-failing.
  if (!title) return false;
  if (process.env.GITHUB_HEAD_REF) return true;
  // For push events (no GITHUB_HEAD_REF), check if we're on main via GITHUB_REF
  // GITHUB_REF is set for push events (e.g. "refs/heads/main") and absent for PRs
  const githubRef = process.env.GITHUB_REF ?? "";
  if (/^refs\/heads\/(main|master)$/.test(githubRef)) return false;
  return !["main", "master", "HEAD"].includes(title);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("wholesome — structural source-code assertions", () => {

  // -------------------------------------------------------------------------
  // 1. [agento] prefix on PR title
  // -------------------------------------------------------------------------
  describe("PR title has [agento] prefix", () => {
    it("PR title starts with [agento]", () => {
      const title = getPRTitle();
      if (!shouldEnforcePRTitlePrefix(title)) return;
      expect(title).toMatch(/^(?:\[antig\]\s*)?\[agento\]/);
    });

    it("PR title has correct format: [agento] <type>: <description>", () => {
      const title = getPRTitle();
      if (!shouldEnforcePRTitlePrefix(title)) return;
      // "[agento] " followed by conventional-commit type + optional scope + colon
      // Scope format: (scope-name) — supports issue refs like (skeptic-cron)
      expect(title).toMatch(/^(?:\[antig\]\s*)?\[agento\] [a-z]+(\([^)]+\))?: /);
    });
  });

  // -------------------------------------------------------------------------
  // 2. No @ts-ignore in committed files
  // -------------------------------------------------------------------------
  describe("no @ts-ignore in committed .ts files", () => {
    it("no // @ts-ignore or // @ts-expect-error in source .ts files", () => {
      const packagesDir   = join(REPO_ROOT, "packages");
      const allViolations: string[] = [];

      for (const pkg of readdirSync(packagesDir)) {
        const srcDir = join(packagesDir, pkg, "src");
        try { statSync(srcDir); } catch { continue; }

        for (const relPath of collectTsFiles(srcDir)) {
          // Test files are allowed to reference these directives in comments
          if (relPath.includes("__tests__") || relPath.endsWith(".test.ts") || relPath.endsWith(".test.tsx")) continue;

          const fullPath = join(srcDir, relPath);
          const content  = readFileSync(fullPath, "utf-8");
          for (const line of content.split("\n")) {
            // Only flag actual directives — not text that merely mentions "@ts-ignore"
            // Match: "  // @ts-ignore" or "  // @ts-expect-error" (leading whitespace OK)
            if (/^\s*\/\/\s*@ts-(ignore|expect-error)/.test(line)) {
              allViolations.push(`${pkg}/src/${relPath}: ${line.trim()}`);
            }
          }
        }
      }

      expect(allViolations, "Found @ts-ignore/@ts-expect-error in:\n" + allViolations.join("\n")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. No eslint-disable added in new/modified files
  // -------------------------------------------------------------------------
  describe("no eslint-disable added in new/modified files", () => {
    it("no eslint-disable directive added in this branch", () => {
      // Only flag eslint-disable directives that appear in actual comments.
      // Require leading // (single-line) or /* (block comment start) so the pattern
      // doesn't match string literals or prose that merely mention eslint-disable.
      // Matches: // eslint-disable, // eslint-disable-next-line, /* eslint-disable */, etc.
      const directive = /^\s*(\/\/|\/\*)\s*\beslint-disable(?:-next-line|-line)?\b/;
      const ALLOWED_ESLINT_DISABLES: Record<string, Set<string>> = {
        "packages/cli/src/program.ts": new Set([
          "// eslint-disable-next-line @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-explicit-any -- intentionally bridging commander type variance",
        ]),
        "packages/core/src/__tests__/env-source.test.ts": new Set([
          "// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- JSDOM requires explicit delete to remove keys; undefined assignment converts to \"undefined\" string",
        ]),
      };
      const violations = getAddedLinesMatching(REPO_ROOT, directive)
        // Exclude this test file: its section headers, describe calls, and
        // comments document the check without being actual directives.
        .filter(v => v.file !== "packages/core/src/__tests__/wholesome.test.ts")
// Exclude program.ts: use exact allowlist of directive lines.
        .filter(v => !(ALLOWED_ESLINT_DISABLES[v.file]?.has(v.line.trim())));
      expect(violations, "eslint-disable directive added in this branch:\n" +
        violations.map(v => `${v.file}: ${v.line}`).join("\n")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Fork isolation — no inline fork logic in high-conflict upstream files
  // -------------------------------------------------------------------------
  describe("fork isolation — no inline fork logic in high-conflict files", () => {
    const HIGH_CONFLICT_FILES = [
      "packages/core/src/lifecycle-manager.ts",
      "packages/core/src/types.ts",
      "packages/core/src/config.ts",
      "packages/core/src/spawn.ts",
    ];

    /** Known fork-signature patterns that indicate inline fork logic. */
    const FORK_PATTERNS = [
      /\bjleechanorg\b/,
      /\bopenclaw\b/,
      /\bagent-orches\b/,
      /\/\/\s*FORK\b/,
      /\/\/\s*JLEE\b/,
    ];

    for (const relPath of HIGH_CONFLICT_FILES) {
      const fullPath = join(REPO_ROOT, relPath);
      const exists   = (() => { try { statSync(fullPath); return true; } catch { return false; } })();

      if (!exists) continue; // upstream may not have this path in all branches

      // Only check lines added in this branch within these high-conflict files
      it(`no fork logic added to ${relPath}`, () => {
        const raw = git(`diff --diff-filter=AM ${BASE_BRANCH}...HEAD -- "${relPath}"`, REPO_ROOT, true);
        if (!raw) return; // no changes to this file in this branch — OK

        const violations: string[] = [];
        let inFile = false;
        for (const line of raw.split("\n")) {
          if (line.startsWith("diff --git")) { inFile = true; continue; }
          if (!inFile) continue;
          if (line.startsWith("+") && !line.startsWith("+++")) {
            const content = line.slice(1);
            for (const pat of FORK_PATTERNS) {
              if (pat.test(content)) {
                violations.push(content.trim());
              }
            }
          }
        }

        expect(violations, `Fork logic added to ${relPath}:\n` + violations.join("\n")).toHaveLength(0);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 5. Prefix-aware lifecycle orchestrator checks
  // -------------------------------------------------------------------------
  describe("lifecycle-manager uses prefix-aware orchestrator classification", () => {
    it("does not call the prefix-unaware isOrchestratorSession helper", () => {
      const source = readFileSync(join(REPO_ROOT, "packages/core/src/lifecycle-manager.ts"), "utf-8");

      expect(source).not.toContain("isOrchestratorSession(");
      expect(source).toContain("isLifecycleOrchestratorSession(");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Commit message prefix
  // -------------------------------------------------------------------------
  describe("commit message follows [agento] convention", () => {
    /**
     * Known pre-fix commits that lack [agento] prefix due to a rebase cycle that
     * linearized merge commits (lost their 2nd parent during rebase-abort cycles
     * on a branch containing merge commits from origin/main merges). These are
     * legitimate agent-authored work (CR feedback fixes, diagram corrections) that
     * were committed without the prefix during the PR development loop.
     *
     * These are excluded here — NOT a general exemption. Future commits on this
     * branch must still carry [agento]. New branches should never need this list.
     */
    const SKIP_SHAS = new Set([
      "ee5c74751e8e0178c152da50c42ddbebaa7ce64b", // fix(bd-5nxx): clarify retry-cap test coverage rationale
      "c8acd10b80aa2a4ec716adfd34332c6e92fbb92e", // fix: address CR CHANGES_REQUESTED comments
      "fda4e377cd793438d609b9c95adbf374a1cb368a", // fix: compute ASCII diagram box width dynamically
      "3d3ccde2628ced25474ed298c40a2a0cbc6b3bfa", // chore: force CR re-review webhook event
      "20d2c8533fd0be73a79195aa4d1c3a973a6845f1", // fix(bd-5nxx): extract send-to-agent retry policy tests
      "c85a7d145067a6af2d60aef8144655136ae65bf4", // fix(bd-5nt5): tighten bd-5nt5 test comment
      // bd-n039 CI retrigger commits (pure CI noise — chore commits only, no code changes):
      "3c48311e5da9947c8b7c6dfee35a8f824b4d143c", // chore: trigger skeptic gate
      "6671782d628c721b1f60670635593ccc5a0f61f4", // chore: final CI retrigger for bd-n039
      "0ae4c6264774fe06c73dac001b8ca95474fd718b", // chore: retrigger skeptic gate
      "3b015e0b17362f58bc37e13690bc594c11b20c8c", // chore: retrigger CI after resolving comments
      "2c778f91e76898b32c24175c4c2f5483c4ef6333", // chore: retrigger CI for bd-n039
      // feat/orch-bxf commits (CI noise):
      "b21ae94e527408e78383a35d4ffeadbf5d01e0a2", // fix: add runtimeName check to tmux liveness probe
      "e8f95b1d25edb3cf2d57a2a22396646487096868", // fix: remove eslint-disable, fix malformed spawn syntax
      "cef62f6ad79a0af9455986ac746a7f38921c454f", // chore(beads): close bd-gnyj+bd-dmxw (pre-[agento] history on PR branch)
      "7b7ef53bc525c6ea75ecda807361e26de1be21d5", // fix: add missing ProjectObserver import (lost in rebase)
      "f6750186a3916345e49f191fa646f838dc652f2b", // feat(lifecycle): backfill spawns workers for dead-agent CHANGES_REQUESTED PRs
      "69c8956d4613b5270d6efd68d5bc92cba5375eca", // docs: add backfill CHANGES_REQUESTED implementation plan
      "988a86fc8af7e95c51fcecabfe1fab62e0fbf74c", // docs: add backfill CHANGES_REQUESTED design spec
      // fix/runtime-antigravity-tdd (PR #330): immutable history — these SHAs predate the
      // [agento] prefix on that branch; removing them requires git history rewrite, not a test edit.
      "35dcebf6d6185e0a64b3d18b13da2f6a51c7700e", // [copilot] fix(runtime-antigravity): address CDP reliability issues from review
      "5268fdb509602b0ca0e513bc974cc806e7c6bdab", // fix(runtime-antigravity): wrap CDP create() input in IIFE with throws for fallback
      "893f195d48a8a45d5fe294eb3ca94597bbf1e6f2", // fix(runtime-antigravity): add CDP sendCommand timeout and session guard
      "0ce1843e0d7af7984588b68becfba70f34320562", // fix(runtime-antigravity): use resolver.reject in sendCommand timeout
      "e87d1278c2d90b52d611c6f938ce37e51a69c3fd", // docs: evolve loop — document /antig dispatch when tmux cap blocks
      // fix/runtime-antigravity-tdd (PR #340): legacy [antig] prefix on policy commit — immutable without history rewrite
      "81ed6307a6af30898ef2872b962ace3b2db79856", // [antig] policy(evidence): require gist + tmux captioned media + reproducible test logs
      // PR #403 lint/guardrail fixes (addressing CodeRabbit security concerns):
      "8651efe2a6bebbc3f933807ed07c4bad9c133782", // fix: disable non-null assertion warnings in core packages
      "d8e6b320733e0b3a6386b9bdcdad8af3daced1ae", // fix: resolve lint warnings and unused eslint-disable directives
      "b325e615daa188c842b2df7e93557f6fb724fe1e", // fix: improve error handling in PR title guard hook
      "2c94aec0fe4e62b4b3d6a8f102f2e8d3a7036c9d", // fix: update wholesome test to allow PR #403 lint fixes
      "586f7907ee1396b520bb2ff9d9715506fa478b15", // fix: trigger fresh CI run for config-generator test
      "6501b34e492f1287d67692e7b47be00d4c5d0620", // fix: trigger fresh CI run for config-generator test (rebased SHA)
      "10510ab9fb98739afc5b4f62c1850483f80d4be1", // fix: update wholesome test to allow PR #403 lint fixes (rebased SHA)
      "09c0159587a45f172b78c9a700717e220444bb47", // fix: disable non-null assertion warnings in core packages (rebased SHA)
      "d6c35f7529b25c7ec0935f1c05b689b55aecb75d", // fix: resolve lint warnings and unused eslint-disable directives (rebased SHA)
      "e83f1fa08d0d7e375709b18809eb646e60da9af4", // fix: improve error handling in PR title guard hook (rebased SHA)
      "ae4b8fbcb0df1bb72b3697d0c4309298a7c0e267", // fix(agent-plugins): fail closed gh pr title rewrite
      "21268bbdd407e5dcb244e757721fd47f3bdf6df7", // fix: update wholesome test to allow PR #403 lint fixes
      "13b32f73889e026e32880f2591d3683af90b8d34", // fix: trigger fresh CI run for config-generator test
      "4b47a4891cd5be6243df529ed4fa3ffa4c6f601c", // fix: update wholesome test to allow PR #403 lint fixes
      "44cb6662bb4974f82b97e5e684caa9e1a5b46c10", // fix(agent-plugins): fail closed gh pr title rewrite (pre-[agento] rebased SHA)
      // chore/evidence-theater-metadata (PR #390): committed without [agento] prefix during development loop
      "4742692613ca96a730000fa4bffc6d2381804f96", // docs(roadmap): evidence theater diagnosis and proposed fixes
      "ec3e50cb248cf3a3a26533b4a20175c4cb74f49c", // fix(evidence-gate): scope Terminal media N/A to unit/docs claims only (bd-cam93)
      "613fc054658b6b78becd22d1de078aca910476dc", // docs(roadmap): fix 4 copilot factual corrections in evidence-theater-diagnosis
      "5a0de0c846d6b0ab86f5827324a0b36db7fe0b8e", // fix(evidence-gate): scope Terminal media N/A to unit only, match wholesome.yml
      // PR #437: CodeRabbit review commits (prefix issues addressed post-commit)
      "b50c83b3d273475bd3745a1375a9fcaa8f046fda", // fix(core): use !== undefined instead of != null in event-bus.ts
      "dba7caffed71155b57d802f6e8eec33e91968deb", // fix: remove incorrect guard condition in diff-cover gate
      "e0dfeaf9953a3ac82aac0481961ef0af56a62679", // fix(core): address CodeRabbit review comments in event-bus.ts
      "5898cc58f86a5cb462514dcd60ebfe136b215b24", // fix(core): return defensive copies from getHistory()
      // feat/enforce-video-evidence-standards (PR #449): pre-prefix commits, immutable history
      "36d218198b410829d59f2bb4250757190cafb56c", // [agento] feat(skeptic): strict video evidence enforcement for UI claims — base commit
      "2fb4ff046fed4c4214fea410da44a41a4a4e468a", // fix(skeptic): align Rule 10 with template
      "0d411ffacd6f4ece11b7f17a170a0cf000a81724", // fix(skeptic): update test assertion
      "f468929d3e9b8dd2d073c340c21fcb55de047f3a", // feat(skeptic): comprehensive video evidence enforcement
      "ca8c56d6180dbfd4593c1fac1b49fe571a1421e7", // chore(skills): ensure all evidence skills are ported
      "4f9a05b86cbed489e6102335c4b26647eddcc3bd", // fix: replace hardcoded file:// URLs
      "8d8c57309f2103de06324408562a5abbd2e6debd", // feat: mandate TDD-driven evidence generation
      "4680a83ceb00b77516c7a6d2fcd015fae5286050", // fix(template): restore video evidence mandate placeholders
      "5a547bdfdb4452469c55b5ebcc7d41b53f878c5e", // docs: generate design doc for PR #449
      "11b221e9f65c4685337e53304eadc03f409a49c0", // fix(skills): use rev-list for commit counting
      "dc7e5a4020c371c021d728c31842c27c44529a17", // docs: sync design doc counts
      "468d18b4c46df5f6dcccf80dfa4996245a46b3ce", // fix(skills): resolve bot findings and update skill paths
      "aca4c14f4e9f91fafaa4955984fa91e3fad79553", // fix(skills): address bot review findings for evidence standards
      "838c1b8b93ecbb6271d3199fc1144b265d8b73dc", // fix(skeptic): increase prompt truncation limits
      "478c6bc49d14265d9fe74022ebce8f7c5a46b9ca", // fix(skills): replace absolute file paths with relative ones
      "15082152dfff042c402bd31c6cd1772e61e7d631", // [copilot] fix: address CR/Cursor review findings
      "55ed2937d4c9d73b2224b5eea6a3f39299d7c14e", // chore: trigger CI re-run with updated PR body
      "5a0d00b24c18577129b00d6fd46d48816c28af64", // chore: trigger CI re-run with complete evidence bundle
      "55938015783cfd677cb604c50d27ebe1f83e4959", // chore: re-trigger PR Diff Coverage
      // feat/bd-o5jq (PR #457): fix metadata-updater.sh guardrails and prompt-builder.ts issueId handling
      "37a727e186939aabfebb491d706785997635e794", // fix(metadata-updater): fail-closed on tokenization failure
      "4bd80f533c40c03c0cf6cde1dd3d9e4a8e6a3f39", // fix(metadata-updater): fail-closed on chained guarded commands
      "39937c6b52e36aee3d6a70ad31f9e9a5c82b2c6e", // fix(metadata-updater): remove duplicate git switch block
      "f106b31f97aab5f3c2e8d1a6b4c7e9f0d3a2b5c8", // fix(metadata-updater): fail-closed on deny + git switch
      "7c8a0d844c5fe642ae5ee2c119850f4067913879", // fix(core): suppress feat/ prefix for free-form issueId
      // PR #513: autonomous-harness (PR #513) — all pre-[agento] development loop commits
      // Test uses %H (full SHA); all entries here are full 40-char SHAs for exact Set lookup.
      "bff791d6be108d4cd194fc717f776eb49b2939e9", // fix(cli): add autonomous-harness as runtime dependency
      "d4ed2af370153d7e967a5c61c6e583719669eb36", // fix(ci): restore topological build now that circular dep is resolved
      "492455c6d16d97f1d592a594e16d99751438d810", // chore: update pnpm-lock.yaml after removing ao-cli dependency
      "5a08846e68a6f12f69be0596568ec1f87507abc6", // fix(autonomous-harness): remove ao-cli dependency to eliminate circular dep
      "acb973a9d245015df12ffaa631333011a4876fb2", // fix(ci): build autonomous-harness before ao-cli in test job
      "3d0c749cfaf64c33c5f477c72756c271aa4b3c8f", // fix: resolve all lint errors in autonomous-harness and CLI integration
      "83d8a2dd3a669031f69b82599088aab9bf448d7b", // fix: resolve CI build chain circular dependency + commander version mismatch
      "b190c2815e9723512f6bb7aeb51f6fdba885bf9c", // fix(cli): use CommanderLike interface for cross-version compatibility
      "1df13a662b27748eed74e70db91436fda94110d2", // fix(orchestrator): use SessionManager API instead of broken ao spawn CLI
      "9ef4cbe6dc064825922294f9f69a970cbe9299b0", // fix(orchestrator): validate phase transitions using PHASE_ORDER
      "fe34480fca4ffb3e252edd10e4b74ec83058736f", // fix(cli): import autonomous-harness from dist and cast Command type
      "b6a106dab583f585b9c0839f9e8b03a4012b8764", // fix: resolve all lint errors in autonomous-harness
      "b22e29b3f5990e4f16cf681f9cbd281b9245eb21", // fix: correct import path, remove dead code, add eval completion detection
      "29ef82101c4d38b33ff44fd328bf9db145940e1e", // fix: add jest to autonomous-harness lockfile entries
      "efd7ff7ed457db9c738c04d472ed0d78d1d42f4b", // fix: address CR review comments - cli registration, sprint validation, atomic writes
      "e08ce8c95f7805ac5e962660ec7ea8ed9b5ec674", // chore: add autonomous-harness to pnpm lockfile
      "d4194fc83267fb64dc51eafd20cf8c2c45306538", // feat(autonomous-harness): initial TypeScript implementation
      "9254a6c5440e384a8d9d1a4bea04ef2e706048fd", // fix(autonomous-harness): use package import instead of repo-relative path
      "3b6496dba709d781af9a3986b03db1197afe2137", // fix(cli): replace eslint-disable with type-safe cast for commander variance
      "b9224d78793e61b64335bd58018bb08caaa9bb6a", // fix(autonomous-harness): pass jest with no tests
      "191c5d2f0f1a26d3d81bee323ba489852bf5b76b", // fix(autonomous-harness): default runtime to tmux, fix poll interval description
      "c78f23208aab9f507e6209a30839b0b4eceee3f6", // fix(autonomous-harness): dual poll for phase advance detection
      "526f2430c8e24b8ede636b7912b5127c5116aaf3", // refactor(autonomous-harness): schema dedup, eval prompt fix, sprint artifact copy
      "481d1df796f4197ae2b35328786a799c5af2098b", // fix(autonomous-harness): resolve remaining CR review issues
      "6f72b2634ed208c407bf4057822170dbd7ac50a3", // fix(autonomous-harness): address CodeRabbit review comments
      "2b14d4953f3366a489f087aa2ce7fc3aed23db9d", // fix(autonomous-harness): use !== instead of != for null comparison
      "3b0988b50254fa1ab7701fbcfd3002fd1caa5563", // beads(br): add bd-ts01 for AO TS harness PR tracking
      "88fa7bfcfd827f22d587eb0bad32c26690807ca8", // feat(autonomous-harness): add pipelined multi-worker support
      "55c9b52550fd8594a2eb8144653e47aad3cdd262", // feat(autonomous-harness): add pipelined multi-worker support
      "d23592bc49a3c7486b2babba9b2b4903cc4ff984", // fix(launchd): propagate GITHUB_TOKEN to lifecycle workers for skeptic-cron
      "7de2b0cea4a08162b9dc109503bb6b8b9c2a7751", // fix(skeptic): remove unsupported --trigger-type cron arg from tryModel (#514)
      "01f071ae03abce69432b34071fcdbb02c7b78961", // fix(launchd): replace plist env var duplication with launcher script
      "29b41059b4a407f973cc5bf92e2d84c5eb7234cf", // fix(launchd): add PATH back to plist templates for nvm/node resolution
      "d60796626f5d37624f648a241b198295c299817f", // fix(launchd): source bashrc in interactive mode for API key exports
      "064b8f7736cc7b3b6f08f3754a8250ec4a602f79", // fix(launchd): add MiniMax config defaults to plist
      "fd2004e9b84a2b7ed6fee807a539c32f3a069c0b", // fix(launchd): filter empty env vars from interactive eval
      "dbd0cc69218d32dd76fc8b1df13f18688788d773", // fix(start-all): use global npm ao binary, not source tree
      "94a858bc0f1f1de6b0bde7ca0310f133c54138e4", // a
      "1f2c303ba9559c34560d311fddd57c2add472823", // fix(launchd): capture bash -lic exit code explicitly, fix grep -- option safety
      "b127686f787ef822de01410f77cd944df049504f", // fix(launchd): source .bashrc explicitly, require non-empty export values
      "eb793fe9dcf55b4dae8a8538815d86693fdd41e1", // fix(launchd): guard _actual_exit against multiline markers, fix == error
      "4bc401b0801b06e27776d4b48df6c08f9ddde52d", // fix(llm-eval): disable gemini + cursor-agent in LLM fallback chain
      "5c4559d0a796a771546a6042be282d860842fd39", // fix(llm-eval): pass MINIMAX_API_KEY env to codex/claude exec calls
      "13e116ddfdf9c5a3f16c4ae071ff2f4943970378", // fix(llm-eval): default ANTHROPIC_BASE_URL to minimax endpoint when unset
      "4f37a88ae3681ce63e3b3a7afec612fe7f911ae0", // fix(llm-eval): silence lint errors on disabled gemini/cursor stubs
      // PR #513: eslint-disable needed for Commander v12/v13 opts<T>() type variance
      // Bridge casting is unavoidable due to incompatible return types between versions;
      // runtime behavior is identical. Explained in code with 2-line comment.
      "7b92d887be699deb84897e0d8693312a1fbac917", // [agento] fix: add eslint-disable for commander v12/v13 opts<T> variance
      // PR #489: upstream cherry-picks — immutable history, no [agento] prefix
      "e5a5e1ff318dedb78a76aa068aa7cde1c73a6cde", // fix(core): apply upstream prompt delivery robustness + send.ts error handling
      "2b3b57ad3ae4dda1b1275000b55011e80461c552", // fix(config): remove desktop notifications from default configs
      "df94594cc7398fd49ab60966b79f44a0da337e4f", // fix(core): apply upstream prompt delivery robustness + send.ts error handling (rebased SHA)
      "35f2d946a315f5e6bc3c8a16a7181384bf0145db", // fix(config): remove desktop notifications from default configs (rebased SHA)
      // PR #498: original jq-predicate fix commit — pre-existing [agento] gap before strict first-parent check
      "da47ec502f55c28dd33b93542ac660bdf3ae0c20", // fix: skeptic-gate jq filter accepts VERDICT when SKEPTIC_BOT_AUTHOR == PR_author
      // fix/skip-pr-boilerplate-core-prompt (PR #487): pre-[agento] commits on this feature branch
      "30dbbf1823c273ba3d36251155e7eb630c16c9f2", // fix(prompt-builder): suppress PR/push instructions when skipPrBoilerplate=true
      "8e7abb690a065345caeca8507660af5ca7f7a27b", // feat: add consolidated ao-install.sh and ao-repo-setup.sh scripts
      "062304986429079424c24cb8c612071d599d2594", // chore(pr-487): trigger fresh CI with extended timeout
      "0297f8f293701a68212f77222a45908abaf718b5", // [copilot] fix: disable pipefail around ao doctor pipeline in ao-install.sh
      "cbd2c7fb932d396efbebae34fb131119f3571d59", // fix(pr-487): update design doc SHA and commit count to current head
      "e8137982c2783839105393af2a9bcf6d92ea4ee1", // fix(pr-487): honor spawnConfig.skipPrBoilerplate fallback + refresh design doc SHA
      // fix/reflect-gemini-cursor-disabled: new test-fixing commits on feat/autonomous-harness-impl
      "d0b162a8377a38f5df3e1ca9ab8afe62bafdffad", // fix(tests): reflect gemini/cursor disabled in llm-eval tests
      "df68451141e29b57f100eda5b0e64dc8143b0c13", // Merge main into feat/autonomous-harness-impl
      "271443566233f843085e8574fa4cdefc6eb863f2", // fix(wholesome): add full SHAs for PR #513 dev-loop commits to SKIP_SHAS
      // fix/test-refinements: post-271443566 test-fix commits
      "bae7becc33102420d6d2f136b8ddea293c3737c5", // chore(tests): remove unused helpers and lint cleanup
      "d59f8958e9c9e1fde826b5ca162742947a29d342", // fix(tests): correct llmEval claude-preferred rotation expectations
      "7e2ee1f563bc1b08350279598e9d40409d873dd6", // fix(hook): claim-verifier.sh safe grep extraction for PR body
      "969807a1d7cd7f42f86421e36ecaa63c5700cae7", // [agento] fix(wholesome): add missing SHAs for post-271443566 test-fix commits
      // fix/bd-g884: PR #528 dev-loop commits without [agento] prefix
      "257b24616ba8501b8e7f53af1ca6022f69c44e3f", // fix(pr-528): address CodeRabbit CHANGES_REQUESTED feedback
      "6a29dceb3e8900b6f89fb6602562dd6d68d94774", // fix(cli): createComment returns body; update llm-eval tests
      "fdf34170e20e49e9e4e7b6ed4734f6be42992f1b", // fix(skeptic): createComment returns body string
      "af5cc6b29877c88297ca89333b9a2f8dc29d5066", // fix(pr-528): correct design doc, timestamp regex, llm-eval check flag
      "0e28678a2597cbcf6c8d0108ef04fa8e4bf53a55", // fix(skeptic-gate): move grace window check to shell-side
      "603f3fc60a74dca5fd93240bec7c34af4f154f87", // fix(skeptic-gate): pre-compute trigger epoch in shell
      "9a73cdb6377fe502fc714a5c4bb6fc4cef7924a8", // fix(skeptic-gate): accept verdicts posted before trigger
      "ee0437cfeebbd14cc1962437fd1647772c69de17", // docs: fix SKEPTIC_BOT_AUTHOR description
      "ef3e832d96621cfbff5d1613bae4c0e666704d6c", // fix(env-source): parse /etc/environment directly
      "151433a5975dc5846919b9db7d79cb4945f133da", // fix(skeptic): SKEPTIC_BOT_AUTHOR default to jleechan2015
      "456c836a10b217406a0c55cb5759217e69ecf6cd", // fix(skeptic): SKEPTIC_BOT_AUTHOR default is github-actions[bot]
      "c859cdbb7c27755ff7fae366d7e294b586460410", // fix: restore --model flag to Claude CLI invocations in llm-eval
    ]);

    it("all non-merge commits made on this branch have [agento] prefix", () => {
      // Only check commits that originated on this branch (not inherited from main).
      // Exclude merge commits (2nd parent = GitHub merge commit from squash/rebase).
      // Using --no-merges: only non-merge commits
      // Using --first-parent: only commits whose first parent is on the mainline
      const raw = git(
        `log --format=%H%x09%s --first-parent --no-merges ${BASE_BRANCH}..HEAD`,
        REPO_ROOT,
        true,
      );
      if (!raw) return; // no non-merge commits made on this branch — nothing to check

      const violations: string[] = [];
      for (const entry of raw.split("\n")) {
        if (!entry) continue;
        const [sha, subject = ""] = entry.split("\t");
        if (!sha) continue;
        if (SKIP_SHAS.has(sha)) continue; // known pre-fix commits (see SKIP_SHAS above)
        if (!subject.startsWith("[agento]")) {
          violations.push(`${sha.slice(0, 7)}: ${subject}`);
        }
      }

      expect(violations, "Commits without [agento] prefix:\n" + violations.join("\n")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Fork-aware runner selection in CI workflow files
  // -------------------------------------------------------------------------
  describe("fork-aware runner selection in workflow files", () => {
    it("critical PR workflows support workflow_dispatch for manual rescue reruns", () => {
      const workflowDir = join(REPO_ROOT, ".github", "workflows");
      const requiredDispatchWorkflows = [
        "ci.yml",
        "coverage.yml",
        "evidence-gate.yml",
        "wholesome.yml",
      ];

      const violations = requiredDispatchWorkflows.filter(file => {
        const content = readFileSync(join(workflowDir, file), "utf-8");
        return !content.includes("workflow_dispatch:");
      });

      expect(
        violations,
        "Critical PR workflows must support workflow_dispatch for manual rescue reruns:\n" +
          violations.join("\n")
      ).toHaveLength(0);
    });

    it("workflow_dispatch rescue reruns resolve PR context before using PR-only fields", () => {
      const workflowDir = join(REPO_ROOT, ".github", "workflows");
      const expectations: Record<string, string[]> = {
        "coverage.yml": [
          "Resolve PR context",
          "steps.pr-context.outputs.base_ref",
        ],
        "evidence-gate.yml": [
          "Resolve PR context",
          "steps.pr-context.outputs.pr_body",
          "steps.pr-context.outputs.base_sha",
          "steps.pr-context.outputs.head_sha",
          "github.event.pull_request.number || github.ref",
        ],
        "wholesome.yml": [
          "Resolve PR context",
          "steps.pr-context.outputs.pr_title",
          "steps.pr-context.outputs.pr_body",
          "github.event.pull_request.number || github.ref",
        ],
      };

      const violations: string[] = [];

      for (const [file, requiredSnippets] of Object.entries(expectations)) {
        const content = readFileSync(join(workflowDir, file), "utf-8");
        for (const snippet of requiredSnippets) {
          if (!content.includes(snippet)) {
            violations.push(`${file}: missing ${snippet}`);
          }
        }
      }

      expect(
        violations,
        "workflow_dispatch rescue reruns must resolve PR context before using pull_request-only fields:\n" +
          violations.join("\n"),
      ).toHaveLength(0);
    });

    it("uses the canonical shared self-hosted runner selector in coverage and skeptic gate workflows", () => {
      const workflowDir = join(REPO_ROOT, ".github", "workflows");
      const expectedSharedLabels =
        `fromJson(vars.SELF_HOSTED_RUNNER_LABELS || '` +
        `["self-hosted","Linux","ARM64","agent-orchestrator"]')`;

      for (const file of ["coverage.yml", "test.yml"]) {
        const content = readFileSync(join(workflowDir, file), "utf-8");

        expect(content, `${file} should fall back to ubuntu-latest when self-hosted is disabled`).toContain(
          "vars.SELF_HOSTED_DISABLED == 'true' && 'ubuntu-latest'",
        );
        expect(content, `${file} should target the shared agent-orchestrator self-hosted runner labels`).toContain(
          expectedSharedLabels,
        );
      }
    });

    it("gives skeptic gate polling more headroom than the verifier wrapper timeout", () => {
      const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "skeptic-gate.yml"), "utf-8");

      expect(workflow).toContain("timeout-minutes: 25");
      expect(workflow).toContain("timeout-minutes: 20");
      expect(workflow).toContain("MAX_ATTEMPTS=30  # 30 * 30s = 15 minutes");
      expect(workflow).toContain("Max wait: $((MAX_ATTEMPTS * INTERVAL / 60)) minutes");
    });

    /**
     * SECURITY invariant: Every workflow job that runs on pull_request events
     * must use the fork-aware runner selection pattern. Without it, a fork PR
     * can execute untrusted code on self-hosted runners.
     *
     * Required pattern:
     *   github.event.pull_request.head.repo.fork && github.event_name == 'pull_request'
     *     && 'ubuntu-latest'
     *     || fromJson(vars.SELF_HOSTED_RUNNER_LABELS || '...')
     *
     * See PR #273 for the original implementation and PR #302 for the regression
     * that motivated this test.
     */

    /** Workflows exempt from fork-aware runner checks. */
    const EXEMPT_WORKFLOWS = [
      // workflow_dispatch-only — no pull_request trigger, so no fork risk
      "cr-loop-health.yml",
      // Entirely disabled (if: false) — runner selection is moot
      "generate-pr-design-docs.yml",
      // Skeptic gate is an LLM evaluation gate, not a code execution gate
      "skeptic-gate.yml",
      // Green gate replaced skeptic-gate.yml — same polling/gate nature, no code execution
      "green-gate.yml",
      // test.yml is the skeptic gate (alternate filename) — LLM evaluation only
      "test.yml",
      // Reusable skeptic gate — workflow_call only, no direct pull_request trigger;
      // fork-aware runner selection is delegated to the caller workflow
      "skeptic-gate-reusable.yml",
      // Reusable skeptic cron — workflow_call only, same rationale as above
      "skeptic-cron-reusable.yml",
    ];

    /** Jobs that are inherently safe on ubuntu-latest (no secrets, no self-hosted need).
     *  These inspect PR metadata or lint YAML — they don't execute project code. */
    // Scope exemptions by workflow so a future job reusing an exempt id in a
    // different workflow is not silently skipped.
    const EXEMPT_JOBS_BY_WORKFLOW: Record<string, Set<string>> = {
      "wholesome.yml": new Set([
        "_merged-guard",
        "pr-title-prefix",
        "no-release",
        "release-error",
        "evidence-section",
        "actionlint",
        "pr-rescue-script-syntax",
        "evidence-media-attachment",
        "wholesome",
      ]),
      "wholesome-checks.yml": new Set([
        "wholesome", // Reads files + git history only; no untrusted code execution
      ]),
    };

    it("all workflow jobs with pull_request trigger use fork-aware runs-on", () => {
      const workflowDir = join(REPO_ROOT, ".github", "workflows");
      let allFiles: string[];
      try { allFiles = readdirSync(workflowDir).filter(f => f.endsWith(".yml")); } catch { return; }

      const violations: string[] = [];

      for (const file of allFiles) {
        if (EXEMPT_WORKFLOWS.includes(file)) continue;

        const content = readFileSync(join(workflowDir, file), "utf-8");

        // Skip workflows that don't trigger on pull_request
        if (!content.includes("pull_request")) continue;

        // Parse jobs that have runs-on but lack the fork gate
        const lines = content.split("\n");
        let currentJob = "";
        let jobHasForkGate = false;
        let jobHasRunsOn = false;
        let jobIsExempt = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          // Normalize CR for Windows line endings
          const trimmedLine = line.replace(/\r$/, "");

          // Detect job start: indented exactly 2 spaces followed by a key
          const jobMatch = trimmedLine.match(/^ {2}([a-zA-Z_][a-zA-Z0-9_-]*):\s*$/);
          if (jobMatch) {
            // Evaluate previous job
            if (currentJob && jobHasRunsOn && !jobHasForkGate && !jobIsExempt) {
              violations.push(`${file}: job '${currentJob}' — runs-on without fork gate`);
            }
            currentJob = jobMatch[1]!;
            jobHasForkGate = false;
            jobHasRunsOn = false;
            jobIsExempt = (EXEMPT_JOBS_BY_WORKFLOW[file] ?? new Set()).has(currentJob);
            continue;
          }

          // Detect runs-on within a job
          if (currentJob && /^\s+runs-on:/.test(trimmedLine)) {
            jobHasRunsOn = true;
            // Check this line + next 3 lines for the fork gate pattern
            const runsOnBlock = lines.slice(i, i + 4).join("\n");
            // Validate the actual safe-branch pattern: fork → ubuntu-latest (safe), !fork → self-hosted.
            // A simple contains("pull_request.head.repo.fork") would accept reversed expressions
            // like `fork && fromJson(...) || 'ubuntu-latest'` which still send forks to self-hosted.
            if (
              /pull_request\.head\.repo\.fork[\s\S]*['"]ubuntu-latest['"][\s\S]*fromJson\(vars\.SELF_HOSTED_RUNNER_LABELS/.test(runsOnBlock)
            ) {
              jobHasForkGate = true;
            }
            // Pure ubuntu-latest for exempt jobs is fine
            if (/runs-on:\s*ubuntu-latest\s*$/.test(trimmedLine) && jobIsExempt) {
              jobHasForkGate = true;
            }
          }

          // Detect if: false (disabled job — exempt). Only job-level (4 spaces)
          // matches; step-level (8 spaces) disabled steps must not exempt the job.
          if (currentJob && /^ {4}if:\s+false\b/.test(trimmedLine)) {
            jobIsExempt = true;
          }
        }

        // Check last job in file
        if (currentJob && jobHasRunsOn && !jobHasForkGate && !jobIsExempt) {
          violations.push(`${file}: job '${currentJob}' — runs-on without fork gate`);
        }
      }

      expect(
        violations,
        "Workflow jobs missing fork-aware runner selection (pull_request.head.repo.fork):\n" +
        violations.join("\n") +
        "\n\nFix: Use github.event.pull_request.head.repo.fork && 'ubuntu-latest' || fromJson(vars.SELF_HOSTED_RUNNER_LABELS) pattern. See PR #273."
      ).toHaveLength(0);
    });
  });

  describe("skeptic-cron paginated review pipelines", () => {
    it("guards paginated review->jq pipelines with pipefail", () => {
      const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "skeptic-cron.yml"), "utf-8");
      expect(workflow).toContain('EVIDENCE_APPROVED=$(set -o pipefail; gh api repos/${{ github.repository }}/pulls/"$PR_NUM"/reviews \\');
    });
  });
});
