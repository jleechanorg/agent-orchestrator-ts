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

/** The base branch for diff comparison. In CI this is GITHUB_BASE_REF (the PR target);
 *  Validated to prevent shell injection — only safe git-ref characters allowed.
 *
 *  In CI (fork PR): GITHUB_BASE_REF is the upstream target (e.g. "main"), checked out
 *  as a local branch, so the bare name is resolvable.
 *
 *  Locally: fall back to origin/HEAD (always points to the remote default branch).
 *  Using a remote tracking ref avoids false negatives when local main is out of sync
 *  with the remote. origin/main may not exist on all remotes, so origin/HEAD is
 *  preferred as the guaranteed remote tracking ref for the default branch. */
const BASE_BRANCH = (() => {
  const raw = process.env.GITHUB_BASE_REF;
  if (raw !== undefined) {
    if (!/^[a-zA-Z0-9/._-]+$/.test(raw) || raw.includes("..")) {
      throw new Error(`Invalid GITHUB_BASE_REF (possible injection): ${raw}`);
    }
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
 * Returns empty string if the command fails.
 * Uses execFileSync with an explicitly parsed arg array to avoid shell injection
 * when any argument contains user-controlled data (e.g. BASE_BRANCH from GITHUB_BASE_REF).
 */
function git(args: string, cwd: string): string {
  try {
    // Split on whitespace but preserve quoted arguments so --jq '.title' stays together.
    const parsed = args.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g)?.map(token =>
      token.replace(/^['"]|['"]$/g, "")
    ) ?? [];
    return execFileSync("git", parsed, { cwd, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/** Return diff lines (with file path) that ADD a given pattern in .ts files. */
function getAddedLinesMatching(cwd: string, pattern: RegExp): Array<{file: string; line: string}> {
  const raw = git(`diff --diff-filter=AM ${BASE_BRANCH}...HEAD`, cwd);
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
  // In CI, use the gh CLI to fetch the actual PR title for the current branch
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
    } catch {
      // gh pr view can fail for branches with no open PR — fall through to branch name
    }
  }
  // Fallback: use branch name (useful for local TDD — correctly fails when prefix is missing)
  return git("rev-parse --abbrev-ref HEAD", REPO_ROOT);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

// import.meta.dirname is the directory of this test file:
//   packages/core/src/__tests__/wholesome.test.ts
// Going up 4 levels reaches the git worktree root (where .git lives):
//   packages/core/src/__tests__ → packages/core/src → packages/core → packages → worktree-root
const REPO_ROOT = import.meta.dirname
  ? join(import.meta.dirname, "..", "..", "..", "..")
  : join(process.cwd()); // CJS fallback

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
      // "[agento] " followed by conventional-commit type + colon
      expect(title).toMatch(/^\[agento\] [a-z]+: /);
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
      // Only flag actual eslint-disable directives. Key insight: the directive name must be
      // followed by whitespace, @ (rule prefix), or / (block comment end) — not a letter.
      // This prevents false positives from "No eslint-disable added" style section headers.
      // Matches: // eslint-disable, // eslint-disable-next-line, /* eslint-disable rule */,
      // // eslint-disable-next-line @typescript-eslint/no-unused-vars, etc.
      const directive = /\beslint-disable(?:-next-line)?\b(?=\s|@|\/)/;
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
        const raw = git(`diff --diff-filter=AM origin/main...HEAD -- "${relPath}"`, REPO_ROOT);
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
    it("all non-merge commits made on this branch have [agento] prefix", () => {
      // Only check commits that originated on this branch (not inherited from main).
      // Exclude merge commits (2nd parent = GitHub merge commit from squash/rebase).
      // Using --no-merges: only non-merge commits
      // Using --first-parent: only commits whose first parent is on the mainline
      const raw = git(`log --format=%H --first-parent --no-merges ${BASE_BRANCH}..HEAD`, REPO_ROOT);
      if (!raw) return; // no non-merge commits made on this branch — nothing to check

      const violations: string[] = [];
      for (const sha of raw.split("\n")) {
        if (!sha) continue;
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
