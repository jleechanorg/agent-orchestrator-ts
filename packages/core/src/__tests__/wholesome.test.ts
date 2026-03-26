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
import { execSync } from "node:child_process";

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
 * Returns empty string if the command fails.
 */
function git(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/** Return diff lines that ADD (not delete) a given pattern in .ts files. */
function getAddedLinesMatching(cwd: string, pattern: RegExp): string[] {
  const raw = git(`diff --diff-filter=AM origin/main...HEAD`, cwd);
  if (!raw) return [];
  const lines: string[] = [];
  let inFile = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      inFile = line.match(/\.(ts|tsx)/) !== null;
      continue;
    }
    if (!inFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      if (pattern.test(content)) {
        lines.push(content.trim());
      }
    }
  }
  return lines;
}

/** Get the PR title — uses gh CLI in CI (GITHUB_TOKEN available), falls back to branch name. */
function getPRTitle(): string {
  // In CI, use the gh CLI to fetch the actual PR title for the current branch
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY && process.env.GITHUB_REF) {
    const repo   = process.env.GITHUB_REPOSITORY; // "owner/repo"
    const branch = process.env.GITHUB_HEAD_REF ?? git("rev-parse --abbrev-ref HEAD", REPO_ROOT);
    try {
      const title = execSync(
        `gh pr view "${branch}" --repo "${repo}" --json title --jq '.title'`,
        { encoding: "utf-8", timeout: 10_000 }
      ).trim();
      if (title && !title.startsWith("graphql")) return title;
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

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

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
    it("no eslint-disable added in this branch", () => {
      const violations = getAddedLinesMatching(REPO_ROOT, /eslint-disable/);
      expect(violations, "eslint-disable added in this branch:\n" + violations.join("\n")).toHaveLength(0);
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
    it("all commits made on this branch have [agento] prefix", () => {
      // Only check commits that originated on this branch (not inherited from main).
      // A commit "originated here" if its first parent is on origin/main.
      const mergeBase = git("merge-base origin/main HEAD", REPO_ROOT);
      if (!mergeBase) return; // cannot determine — skip

      // origin/main..HEAD gives commits on this branch not reachable from main.
      // --first-parent walks only the primary history (excludes side branches).
      const raw = git(`log --format=%H --first-parent origin/main..HEAD`, REPO_ROOT);
      if (!raw) return; // no commits made on this branch — nothing to check

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
