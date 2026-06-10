import { accessSync, constants as fsConstants } from "node:fs";
import {
  LLM_EVAL_TIMEOUT_MS,
  STRICT_VERDICT_RE,
  type LlmEvalResult,
  isUnavailable,
  isAuthError,
} from "./llm-eval-shared.js";

/** Known agy (Google Antigravity/Gemini CLI) binary locations, tried in order. */
const AGY_BINARY_CANDIDATES = [
  process.env["AGY_BINARY"] ?? "",
  process.env["HOME"] ? `${process.env["HOME"]}/.local/bin/agy` : "",
  "/usr/local/bin/agy",
  "/opt/homebrew/bin/agy",
  "agy",
].filter(Boolean);

/**
 * Run agy (Google Antigravity CLI) for headless evaluation.
 * Fail-closed: missing VERDICT = failure.
 */
export async function tryAgyPrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");

  // Ensure /tmp and os.tmpdir() are trusted in the active trustedFolders.json
  const homeDir = process.env["HOME"] || os.homedir();
  const trustedFoldersPath = path.join(homeDir, ".gemini", "trustedFolders.json");

  try {
    fs.mkdirSync(path.dirname(trustedFoldersPath), { recursive: true });
    let trustedFolders: Record<string, string> = {};
    // Skip the write if we fail to read/parse an existing file — overwriting
    // could erase unrelated trust entries in the user's global Gemini config.
    // Mirrors the skip-on-parse-failure pattern in
    // packages/plugins/agent-antigravity/src/index.ts.
    let shouldWrite = true;
    if (fs.existsSync(trustedFoldersPath)) {
      try {
        const raw = fs.readFileSync(trustedFoldersPath, "utf-8").trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            trustedFolders = parsed as Record<string, string>;
          }
        }
      } catch {
        // Parse failure — do not overwrite the user's existing config
        shouldWrite = false;
      }
    }

    const pathsToTrust = ["/tmp", "/private/tmp", os.tmpdir()];
    for (const p of pathsToTrust) {
      if (!p) continue;
      trustedFolders[p] = "TRUST_FOLDER";
      try {
        const resolved = fs.realpathSync(p);
        trustedFolders[resolved] = "TRUST_FOLDER";
      } catch {
        // ignore
      }
    }

    if (shouldWrite) {
      fs.writeFileSync(trustedFoldersPath, JSON.stringify(trustedFolders, null, 2), "utf-8");
    }
  } catch {
    // ignore write error
  }

  let firstInfraError: string | undefined;
  let allMissing = true;

  for (const candidate of AGY_BINARY_CANDIDATES) {
    if (!candidate) continue;

    if (candidate !== "agy") {
      try {
        accessSync(candidate, fsConstants.X_OK);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          continue;
        }
        allMissing = false;
        if (!firstInfraError) {
          firstInfraError = err instanceof Error ? err.message : String(err);
        }
        continue;
      }
    }

    try {
      allMissing = false;
      const isGemini = path.basename(candidate).includes("gemini");
      const permissionFlag = isGemini ? "--yolo" : "--dangerously-skip-permissions";
      const result = execFileSync(
        candidate,
        [permissionFlag, "-p", ""],
        {
          input: prompt,
          encoding: "utf-8",
          timeout: LLM_EVAL_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "ignore"],
          cwd: "/tmp",
        },
      );
      const output = result.trim();
      if (!STRICT_VERDICT_RE.test(output)) {
        return {
          validVerdict: false,
          output,
          error: `agy output missing VERDICT line (got ${output.slice(0, 100)}...)`,
        };
      }
      return { validVerdict: true, output };
    } catch (err: unknown) {
      const errno = (err as NodeJS.ErrnoException).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (errno === "ENOENT") {
        continue;
      }
      if (errno === "ETIMEDOUT") {
        continue;
      }
      if (isAuthError(msg)) {
        return { validVerdict: false, output: "", error: undefined };
      }
      if (isUnavailable(msg, errno as string)) {
        continue;
      }
      if (!firstInfraError) {
        firstInfraError = msg.split("\n")[0]?.slice(0, 300);
      }
      continue;
    }
  }

  if (allMissing) {
    return { validVerdict: false, output: "", error: undefined };
  }

  return { validVerdict: false, output: "", error: firstInfraError };
}
