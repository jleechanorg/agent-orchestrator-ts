import { join } from "node:path";
import { existsSync } from "node:fs";
import { expandHome } from "./paths.js";

/**
 * Resolves the absolute path to the 'gh' binary.
 * Checks common installation directories to ensure compatibility even when
 * executed within daemon/worker contexts (e.g. launched by launchd) where
 * the user's custom PATH might not be fully populated.
 */
export function getGhBinaryPath(): string {
  if (process.env.AO_GH_PATH) {
    return process.env.AO_GH_PATH;
  }
  const commonPaths = [
    join(expandHome("~/.local/bin"), "gh"),
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
    "/bin/gh",
  ];
  for (const p of commonPaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return "gh";
}
