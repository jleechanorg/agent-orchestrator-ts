/**
 * Locate fibonacci.py after a Claude one-shot task; some models write ./scripts/fibonacci.py.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";

import { sleep } from "./polling.js";

const CANDIDATE_REL_PATHS = ["fibonacci.py", join("scripts", "fibonacci.py")];

export async function resolveFibonacciPy(workspaceRoot: string): Promise<string | null> {
  for (const rel of CANDIDATE_REL_PATHS) {
    const p = join(workspaceRoot, rel);
    try {
      await access(p);
      return p;
    } catch {
      continue;
    }
  }
  return null;
}

/** Poll until fibonacci.py appears (process exit can race ahead of filesystem flush). */
export async function waitForFibonacciPy(
  workspaceRoot: string,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<string | null> {
  const { timeoutMs, intervalMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await resolveFibonacciPy(workspaceRoot);
    if (p) return p;
    await sleep(intervalMs);
  }
  return null;
}

/** Prompt Claude to prefer workspace root; still resolve nested path if it ignores instructions. */
export const FIBONACCI_PROMPT_ONE_SHOT = [
  "Write a Python fibonacci program.",
  "Save it as ./fibonacci.py in the workspace root (current directory).",
  "Do not create a scripts/ folder or any subdirectories.",
  "The program should print the first 10 fibonacci numbers when run.",
  "Write only the file, no explanation.",
].join(" ");
