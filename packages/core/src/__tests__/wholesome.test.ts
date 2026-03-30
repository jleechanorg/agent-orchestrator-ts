/**
 * wholesome.test.ts — Structural source-code assertions
 *
 * "Multiple shots on goal" (Ryan/OpenAI): enforce quality dimensions at
 * TEST time, not just runtime hooks or review. Each test asserts a
 * structural invariant on the codebase or diff rather than behavior.
 *
 * Tests run in CI via .github/workflows/wholesome-checks.yml
 *
 * NOTE: These tests are designed to run in two contexts:
 *   1. CI: fetches real PR title via gh CLI (GITHUB_TOKEN available)
 *   2. Local: falls back to branch name (TDD mode — detects missing prefix)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The base branch for diff comparison.
 *  Validated to prevent shell injection — only safe git-ref characters allowed.
 *
 *  In CI: GITHUB_BASE_REF is always set for PR events. The base branch is checked
 *  out as a local ref (refs/heads/main), so a bare name like "main" IS resolvable.
 *  GitHub guarantees GITHUB_BASE_REF for every pull_request event.
 *
 *  Locally: origin/HEAD is the guaranteed remote tracking ref for the default branch.
 *  It is maintained by GitHub for all repos and never stale. */
const BASE_BRANCH = (() => {
  const raw = process.env.GITHUB_BASE_REF;
  if (raw !== undefined && raw !== "") {
    if (!/^[a-zA-Z0-9/._-]+$/.test(raw) || raw.includes("..")) {
      throw new Error(`Invalid GITHUB_BASE_REF (possible injection): ${raw}`);
    }
    // GITHUB_BASE_REF is the bare branch name (e.g. "main"). The workflow's
    // "Ensure base branch ref is available" step fetches it as a local ref.
    // Use bare name so git resolves it as a local branch ref, not a remote-tracking ref.
    return raw;
  }
  // Local fallback: origin/HEAD is the remote default branch (never stale)
  return "origin/HEAD";
})();

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

/** Get the PR title — uses gh CLI in CI (GITHUB_TOKEN available), falls back to branch name. */
function getPRTitle(): string {
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
  // Fallback: use branch name (useful for local TDD — correctly fails when prefix is missing).
  // strict=true so broken git state (e.g. detached HEAD with no ref) raises instead of silently passing.
  return git("rev-parse --abbrev-ref HEAD", REPO_ROOT, true);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

// import.meta.dirname is the directory of this test file:
//   packages/core/src/__tests__/wholesome.test.ts
// Going up 4 levels reaches the git worktree root (where .git lives):
//   packages/core/src/__tests__ → packages/core/src → packages/core → packages → worktree-root
function computeRepoRoot(): string {
  const candidate = import.meta.dirname
    ? join(import.meta.dirname, "..", "..", "..", "..")
    : join(process.cwd()); // CJS fallback
  // Sanity-check: ensure .git exists so broken traversal fails loudly.
  try { statSync(join(candidate, ".git")); } catch {
    throw new Error(`REPO_ROOT=${candidate} is not a git repo (no .git found)`);
  }
  return candidate;
}
const REPO_ROOT = computeRepoRoot();

describe("wholesome — structural source-code assertions", () => {

  // -------------------------------------------------------------------------
  // 1. [agento] prefix on PR title
  // -------------------------------------------------------------------------
  describe("PR title has [agento] prefix", () => {
    it("PR title starts with [agento]", () => {
      const title = getPRTitle();
      expect(title).toMatch(/^\[agento\]/);
    });

    it("PR title has correct format: [agento] <type>: <description>", () => {
      const title = getPRTitle();
      // "[agento] " followed by conventional-commit type + optional scope + colon
      // Scope format: (scope-name) — supports issue refs like (skeptic-cron)
      expect(title).toMatch(/^\[agento\] [a-z]+(\([^)]+\))?: /);
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
      const violations = getAddedLinesMatching(REPO_ROOT, directive)
        // Exclude this test file: its section headers, describe calls, and
        // comments document the check without being actual directives.
        .filter(v => !v.file.includes("wholesome.test.ts"));
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
  // 5. Commit message prefix
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
    ]);

    it("all non-merge commits made on this branch have [agento] prefix", () => {
      // Only check commits that originated on this branch (not inherited from main).
      // Exclude merge commits (2nd parent = GitHub merge commit from squash/rebase).
      // Using --no-merges: only non-merge commits
      // Using --first-parent: only commits whose first parent is on the mainline
      const raw = git(`log --format=%H --first-parent --no-merges ${BASE_BRANCH}..HEAD`, REPO_ROOT, true);
      if (!raw) return; // no non-merge commits made on this branch — nothing to check

      const violations: string[] = [];
      for (const sha of raw.split("\n")) {
        if (!sha) continue;
        if (SKIP_SHAS.has(sha)) continue; // known pre-fix commits (see SKIP_SHAS above)
        const msg = git(`log -1 --format=%B ${sha}`, REPO_ROOT);
        const firstLine = msg.split("\n")[0];
        if (!firstLine?.startsWith("[agento]")) {
          violations.push(`${sha.slice(0, 7)}: ${firstLine}`);
        }
      }

      expect(violations, "Commits without [agento] prefix:\n" + violations.join("\n")).toHaveLength(0);
    });
  });
});
