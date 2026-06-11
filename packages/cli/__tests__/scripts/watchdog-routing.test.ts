import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function getChannel(scriptName: string, envOverrides: Record<string, string>): string {
  const scriptPath = join(repoRoot, "scripts", scriptName);
  const fullContent = readFileSync(scriptPath, "utf-8");
  
  // Split lines and find where CHANNEL is defined (strict start-of-line variable)
  const lines = fullContent.split("\n");
  const channelIndex = lines.findIndex(line => /^\s*CHANNEL=/.test(line));
  if (channelIndex === -1) {
    throw new Error(`Could not find CHANNEL= in ${scriptName}`);
  }
  
  // Extract up to the CHANNEL definition and print the channel
  const snippet = `
    # Stub BASH_SOURCE to prevent set -u unbound variable warning
    BASH_SOURCE=("/tmp/${scriptName}")
  ` + lines.slice(0, channelIndex + 1).join("\n") + "\n" + 'echo "$CHANNEL"\n';

  const envClone = { ...process.env };
  delete envClone.HERMES_WATCHDOG_ALERT_CHANNEL;
  delete envClone.HEALTH_GUARDIAN_ALERT_CHANNEL;
  delete envClone.HERMES_OPS_SLACK_CHANNEL;

  const result = execSync("bash", {
    input: snippet,
    env: {
      ...envClone,
      ...envOverrides,
    },
  });
  return result.toString().trim();
}

describe("watchdog alert channel routing", () => {
  describe("hermes-watchdog.sh", () => {
    it("defaults to C0AJ3SD5C79 when no env vars are set", () => {
      const channel = getChannel("hermes-watchdog.sh", {});
      expect(channel).toBe("C0AJ3SD5C79");
    });

    it("uses HERMES_OPS_SLACK_CHANNEL override if set", () => {
      const channel = getChannel("hermes-watchdog.sh", {
        HERMES_OPS_SLACK_CHANNEL: "C0TESTOPS12",
      });
      expect(channel).toBe("C0TESTOPS12");
    });

    it("prefers HERMES_WATCHDOG_ALERT_CHANNEL over HERMES_OPS_SLACK_CHANNEL", () => {
      const channel = getChannel("hermes-watchdog.sh", {
        HERMES_WATCHDOG_ALERT_CHANNEL: "C0WDONLY123",
        HERMES_OPS_SLACK_CHANNEL: "C0TESTOPS12",
      });
      expect(channel).toBe("C0WDONLY123");
    });
  });

  describe("ai.agento.health-guardian.sh", () => {
    it("defaults to C0AJ3SD5C79 when no env vars are set", () => {
      const channel = getChannel("ai.agento.health-guardian.sh", {});
      expect(channel).toBe("C0AJ3SD5C79");
    });

    it("uses HERMES_OPS_SLACK_CHANNEL override if set", () => {
      const channel = getChannel("ai.agento.health-guardian.sh", {
        HERMES_OPS_SLACK_CHANNEL: "C0TESTOPS12",
      });
      expect(channel).toBe("C0TESTOPS12");
    });

    it("prefers HEALTH_GUARDIAN_ALERT_CHANNEL over HERMES_OPS_SLACK_CHANNEL", () => {
      const channel = getChannel("ai.agento.health-guardian.sh", {
        HEALTH_GUARDIAN_ALERT_CHANNEL: "C0HGONLY123",
        HERMES_OPS_SLACK_CHANNEL: "C0TESTOPS12",
      });
      expect(channel).toBe("C0HGONLY123");
    });
  });
});
