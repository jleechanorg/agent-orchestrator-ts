import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// Resolve the CHANNEL value the script would compute given an env.
// Strips the call to post_slack so the snippet stays fast and side-effect free.
function getChannel(scriptName: string, envOverrides: Record<string, string>): string {
  const scriptPath = join(repoRoot, "scripts", scriptName);
  const fullContent = readFileSync(scriptPath, "utf-8");

  const lines = fullContent.split("\n");
  const channelIndex = lines.findIndex(line => /^\s*CHANNEL=/.test(line));
  if (channelIndex === -1) {
    throw new Error(`Could not find CHANNEL= in ${scriptName}`);
  }

  // Extract up to the CHANNEL definition and print the channel. Stub
  // BASH_SOURCE so `set -u` does not warn on the unbound reference.
  const snippet = `
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

// PR #615 umbrella pattern: empty default > wrong default. Both watchdogs
// follow the same resolver chain:
//
//   plist env (HEALTH_GUARDIAN_ALERT_CHANNEL / HERMES_WATCHDOG_ALERT_CHANNEL)
//   -> HERMES_OPS_SLACK_CHANNEL
//   -> empty (fail-soft in post_slack; no Slack call is made)
//
// Regression history: PR #681 (commit d8940175b) introduced a hardcoded
// `C0AJ3SD5C79` (design channel) default plus a back-ass guard that actively
// unset HEALTH_GUARDIAN_ALERT_CHANNEL when it equalled the ops channel
// `C09GRLXF9GR`. The plist template also lost its env entry. This test
// would have caught that regression.

describe("watchdog alert channel routing (PR #615 umbrella pattern)", () => {
  describe("hermes-watchdog.sh", () => {
    it("resolves to empty (no channel bleed) when no env vars are set", () => {
      const channel = getChannel("hermes-watchdog.sh", {});
      expect(channel).toBe("");
    });

    it("uses HERMES_OPS_SLACK_CHANNEL when plist env is unset", () => {
      const channel = getChannel("hermes-watchdog.sh", {
        HERMES_OPS_SLACK_CHANNEL: "C0TESTOPS12",
      });
      expect(channel).toBe("C0TESTOPS12");
    });

    it("prefers plist env (HERMES_WATCHDOG_ALERT_CHANNEL) over HERMES_OPS_SLACK_CHANNEL", () => {
      const channel = getChannel("hermes-watchdog.sh", {
        HERMES_WATCHDOG_ALERT_CHANNEL: "C0WDONLY123",
        HERMES_OPS_SLACK_CHANNEL: "C0TESTOPS12",
      });
      expect(channel).toBe("C0WDONLY123");
    });

    // Regression: PR #681 stripped HERMES_WATCHDOG_ALERT_CHANNEL=C09GRLXF9GR
    // (the live plist value, the correct ops channel). With the regression
    // removed, C09GRLXF9GR must now resolve through normally.
    it("passes HERMES_WATCHDOG_ALERT_CHANNEL=C09GRLXF9GR through unchanged", () => {
      const channel = getChannel("hermes-watchdog.sh", {
        HERMES_WATCHDOG_ALERT_CHANNEL: "C09GRLXF9GR",
      });
      expect(channel).toBe("C09GRLXF9GR");
    });
  });

  describe("ai.agento.health-guardian.sh", () => {
    it("resolves to empty (no channel bleed) when no env vars are set", () => {
      const channel = getChannel("ai.agento.health-guardian.sh", {});
      expect(channel).toBe("");
    });

    it("uses HERMES_OPS_SLACK_CHANNEL when plist env is unset", () => {
      const channel = getChannel("ai.agento.health-guardian.sh", {
        HERMES_OPS_SLACK_CHANNEL: "C0TESTOPS12",
      });
      expect(channel).toBe("C0TESTOPS12");
    });

    it("prefers plist env (HEALTH_GUARDIAN_ALERT_CHANNEL) over HERMES_OPS_SLACK_CHANNEL", () => {
      const channel = getChannel("ai.agento.health-guardian.sh", {
        HEALTH_GUARDIAN_ALERT_CHANNEL: "C0HGONLY123",
        HERMES_OPS_SLACK_CHANNEL: "C0TESTOPS12",
      });
      expect(channel).toBe("C0HGONLY123");
    });

    // Regression: PR #681 actively unset HEALTH_GUARDIAN_ALERT_CHANNEL when
    // it equalled C09GRLXF9GR, so the live plist value was silently dropped
    // and the script fell through to the wrong hardcoded default. The
    // channel must now resolve through.
    it("passes HEALTH_GUARDIAN_ALERT_CHANNEL=C09GRLXF9GR through unchanged (PR #681 regression)", () => {
      const channel = getChannel("ai.agento.health-guardian.sh", {
        HEALTH_GUARDIAN_ALERT_CHANNEL: "C09GRLXF9GR",
      });
      expect(channel).toBe("C09GRLXF9GR");
    });

    it("live plist pattern: HEALTH_GUARDIAN_ALERT_CHANNEL=C09GRLXF9GR wins, no HERMES_OPS_SLACK_CHANNEL set", () => {
      // Mirrors the actual installed plist at
      // ~/Library/LaunchAgents/ai.agento.health-guardian.plist: it sets
      // HEALTH_GUARDIAN_ALERT_CHANNEL=C09GRLXF9GR and does not set
      // HERMES_OPS_SLACK_CHANNEL. Under PR #681 the channel bled to
      // C0AJ3SD5C79. With the fix, C09GRLXF9GR is the resolved channel.
      const channel = getChannel("ai.agento.health-guardian.sh", {
        HEALTH_GUARDIAN_ALERT_CHANNEL: "C09GRLXF9GR",
      });
      expect(channel).toBe("C09GRLXF9GR");
    });
  });

  describe("plumbed-in fix: post_slack refuses empty channel", () => {
    // The empty-channel guard inside post_slack is what makes the
    // "no env -> CHANNEL=''" path safe. If someone re-introduces a
    // hardcoded default in the resolver, the post would silently bleed
    // to the wrong channel. If someone removes the guard, the post would
    // call chat.postMessage with channel="" and Slack would error.
    it.each([
      "hermes-watchdog.sh",
      "ai.agento.health-guardian.sh",
    ])("%s sources have an empty-channel guard in post_slack", (scriptName) => {
      const content = readFileSync(join(repoRoot, "scripts", scriptName), "utf-8");
      expect(content).toMatch(/if \[ -z "\$CHANNEL" \]; then/);
      expect(content).toMatch(/no CHANNEL resolved; cannot post/);
    });
  });
});
