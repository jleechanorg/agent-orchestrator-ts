import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// Resolve the HERMES_WD_LOG value the script would compute given an env.
// Strips the script up to (and including) the HERMES_WD_LOG assignment so the
// snippet stays fast and side-effect free.
function getHermesWatchdogLog(envOverrides: Record<string, string>): string {
  const scriptPath = join(repoRoot, "scripts", "ai.agento.health-guardian.sh");
  const fullContent = readFileSync(scriptPath, "utf-8");

  const lines = fullContent.split("\n");
  const logIndex = lines.findIndex(line =>
    /^\s*HERMES_WD_LOG=/.test(line),
  );
  if (logIndex === -1) {
    throw new Error("Could not find HERMES_WD_LOG= in ai.agento.health-guardian.sh");
  }

  // Stub BASH_SOURCE so `set -u` does not warn on the unbound reference.
  const snippet =
    `BASH_SOURCE=("/tmp/ai.agento.health-guardian.sh")\n` +
    lines.slice(0, logIndex + 1).join("\n") +
    `\necho "$HERMES_WD_LOG"\n`;

  const envClone = { ...process.env };
  delete envClone.HERMES_WD_LOG;

  const result = execSync("bash", {
    input: snippet,
    env: {
      ...envClone,
      ...envOverrides,
    },
  });
  return result.toString().trim();
}

// PR #716 regression test: Check 2 of ai.agento.health-guardian.sh used to
// hardcode HERMES_WD_LOG="/tmp/hermes-watchdog.log". That path never existed
// (launchd's StandardOutPath default on macOS is ~/Library/Logs/), so
// HERMES_FRESH was always 0 and the guardian fired a false-positive
// "log stale or missing" alert every hour into #all-jleechan-ai.
// The fix points Check 2 at the real log path with an env override for
// non-default setups.
describe("ai.agento.health-guardian.sh — HERMES_WD_LOG default (PR #716)", () => {
  it("resolves to $HOME/Library/Logs/hermes-watchdog.log when no env override is set", () => {
    const log = getHermesWatchdogLog({});
    expect(log).toBe(`${process.env.HOME}/Library/Logs/hermes-watchdog.log`);
  });

  it("does NOT default to /tmp/hermes-watchdog.log (PR #716 regression)", () => {
    // The old hardcoded path was "/tmp/hermes-watchdog.log" — that file
    // never exists because launchd writes to ~/Library/Logs/. This assertion
    // would have failed before the fix and passes after.
    const log = getHermesWatchdogLog({});
    expect(log).not.toBe("/tmp/hermes-watchdog.log");
    // Belt-and-suspenders: confirm the old path really is absent on this
    // host, otherwise the regression would be masked.
    expect(existsSync("/tmp/hermes-watchdog.log")).toBe(false);
  });

  it("honors an explicit HERMES_WD_LOG env override for non-default setups", () => {
    const customPath = "/var/log/custom-hermes-watchdog.log";
    const log = getHermesWatchdogLog({ HERMES_WD_LOG: customPath });
    expect(log).toBe(customPath);
  });

  it("source uses ${HERMES_WD_LOG:-$HOME/Library/Logs/hermes-watchdog.log} (parameter expansion, not hardcoded)", () => {
    // Belt against the regression coming back: the line must use parameter
    // expansion, not a literal "/tmp/hermes-watchdog.log".
    const scriptPath = join(repoRoot, "scripts", "ai.agento.health-guardian.sh");
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toMatch(
      /HERMES_WD_LOG="\$\{HERMES_WD_LOG:-\$HOME\/Library\/Logs\/hermes-watchdog\.log\}"/,
    );
    expect(content).not.toMatch(/^HERMES_WD_LOG=["']?\/tmp\/hermes-watchdog\.log/);
  });
});
