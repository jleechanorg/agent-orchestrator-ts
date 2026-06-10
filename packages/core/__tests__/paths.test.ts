import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

/**
 * bd-1xdg: TDD guard test for the canonical tilde-expansion helper.
 *
 * Two test groups:
 *  1. Unit tests for `expandHome()` behavior.
 *  2. A repository-wide static check that fails if any app-code file
 *     reinvents tilde expansion with a local copy of `expandPath`,
 *     an inline `replace(/^~/, ...)`, or a `startsWith("~/")` check
 *     that resolves to `homedir()`. The canonical helper is the
 *     single source of truth at `packages/core/src/paths.ts`.
 */

let expandHome: (input: string) => string;

beforeAll(async () => {
  const mod = await import("../src/paths.js");
  expandHome = mod.expandHome;
});

describe("expandHome (canonical helper)", () => {
  it("expands ~/foo to <HOME>/foo", () => {
    expect(expandHome("~/foo")).toBe(join(homedir(), "foo"));
  });

  it("expands ~/ nested paths to <HOME>/a/b/c", () => {
    expect(expandHome("~/a/b/c")).toBe(join(homedir(), "a/b/c"));
  });

  it("expands ~\\foo to <HOME>/foo", () => {
    expect(expandHome("~\\foo")).toBe(join(homedir(), "foo"));
  });

  it("expands ~\\ nested paths to <HOME>/a\\b\\c", () => {
    expect(expandHome("~\\a\\b\\c")).toBe(join(homedir(), "a\\b\\c"));
  });

  it("returns the input unchanged for an absolute path", () => {
    expect(expandHome("/abs/foo")).toBe("/abs/foo");
  });

  it("returns the input unchanged for a relative path", () => {
    expect(expandHome("foo/bar")).toBe("foo/bar");
  });

  it("returns the input unchanged for an empty string", () => {
    expect(expandHome("")).toBe("");
  });

  it("returns the input unchanged when the path starts with ~user (not ~/)", () => {
    // expandHome intentionally only handles ~/... — explicit ~user is unsupported.
    expect(expandHome("~user/foo")).toBe("~user/foo");
  });

  it("returns the input unchanged when there is no leading tilde", () => {
    expect(expandHome("a/~/b")).toBe("a/~/b");
  });

  it("returns the input unchanged for a bare tilde (canonical helper scope is ~/...)", () => {
    // The canonical helper only expands ~/... ; bare '~' is intentionally untouched.
    // Callers that need bare-'~' expansion should pre-process before calling expandHome.
    expect(expandHome("~")).toBe("~");
  });
});

describe("bd-1xdg static guard — no tilde-expansion reinvention in app code", () => {
  /**
   * Walk the source tree looking for files that bypass the canonical helper.
   * Each match is a defect that should be migrated to use `expandHome`.
   *
   * The canonical helper itself (`packages/core/src/paths.ts`) and the
   * config validation sites (which guard `~/` as an allowlist prefix, not
   * for expansion) are explicitly excluded.
   */

  const ALLOWED_FILES = new Set<string>([
    // Canonical helper itself
    "packages/core/src/paths.ts",
    // Config validation uses startsWith('~/') as a security allowlist, not for expansion
    "packages/core/src/config.ts",
    // The unit test that asserts the guard below
    "packages/core/__tests__/paths.test.ts",
  ]);

  const SCAN_DIRS = [
    "packages/cli/src",
    "packages/core/src",
    "packages/plugins",
  ];

  type Violation = {
    file: string;
    line: number;
    pattern: string;
    snippet: string;
  };

  function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
        out.push(...listTsFiles(full));
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  function findViolations(): Violation[] {
    const violations: Violation[] = [];
    const inlineReplace = /\.replace\(\s*\/\^~\//;
    const startsWithTilde = /\bif\s*\(\s*\w+\.startsWith\(\s*["']~\/["']\s*\)/;

    for (const scanDir of SCAN_DIRS) {
      const absDir = join(repoRoot, scanDir);
      let files: string[];
      try {
        files = listTsFiles(absDir);
      } catch {
        continue;
      }
      for (const file of files) {
        const rel = file.slice(repoRoot.length + 1);
        if (ALLOWED_FILES.has(rel)) continue;

        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (inlineReplace.test(line)) {
            violations.push({
              file: rel,
              line: i + 1,
              pattern: "replace(/^~/, ...)",
              snippet: line.trim(),
            });
          }
          if (startsWithTilde.test(line)) {
            // Only flag when paired with homedir()/HOME/userHome on a nearby line —
            // that's the "reinvented expandPath" pattern. A bare `startsWith('~/')`
            // for validation is legitimate.
            const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join("\n");
            if (/homedir\(\)|process\.env\[["']HOME["']\]|userHome/.test(window)) {
              violations.push({
                file: rel,
                line: i + 1,
                pattern: "startsWith('~/') ... homedir()/HOME (reinvented expandPath)",
                snippet: line.trim(),
              });
            }
          }
        }
      }
    }
    return violations;
  }

  it("has zero tilde-expansion reinventions outside the canonical helper", () => {
    const violations = findViolations();
    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  - ${v.file}:${v.line}  [${v.pattern}]\n      ${v.snippet}`)
        .join("\n");
      throw new Error(
        `bd-1xdg: tilde expansion must route through packages/core/src/paths.ts#expandHome.\n` +
          `Found ${violations.length} bypass site(s):\n${formatted}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
