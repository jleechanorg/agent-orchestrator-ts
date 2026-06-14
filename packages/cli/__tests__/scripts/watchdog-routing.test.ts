import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  describe("plumbed-in fix: dedupe fingerprint recorded only after successful post", () => {
    // Regression: chatgpt-codex-connector P2 on PR #687 — the previous
    // `dedup_should_send` wrote the fingerprint BEFORE post_slack ran.
    // When post_slack failed (empty channel, missing token, network error),
    // the fingerprint was still recorded, so the next real alert within the
    // dedupe window was hidden. The fix splits the function into a pure
    // check (`dedup_already_sent`) and a separate `dedup_record` step that
    // the alert flow calls only on post success.
    it.each([
      "hermes-watchdog.sh",
      "ai.agento.health-guardian.sh",
    ])(
      "%s splits dedup into a check + a record step called only on post success",
      (scriptName) => {
        const content = readFileSync(join(repoRoot, "scripts", scriptName), "utf-8");
        // The old combined function must not be CALLED anywhere — it would
        // re-introduce the regression. (The name may appear in a comment as
        // historical context; that's allowed.)
        expect(content).not.toMatch(/^\s*dedup_should_send\s+/m);
        // The check (no file mutation) and the record (writes to DEDUPE_FILE)
        // must be separate functions.
        expect(content).toMatch(/^dedup_already_sent\s*\(\)\s*\{/m);
        expect(content).toMatch(/^dedup_record\s*\(\)\s*\{/m);
        // And the record function must be the one that writes to DEDUPE_FILE.
        const dedupRecordMatch = content.match(/^dedup_record\(\)\s*\{[\s\S]*?^\}/m);
        expect(dedupRecordMatch).not.toBeNull();
        expect(dedupRecordMatch![0]).toMatch(/DEDUPE_FILE/);
        // The record function must NOT be called before post_slack. We check
        // the call site is after `post_slack` in source order.
        const postSlackIdx = content.indexOf("post_slack \"$body\"");
        const dedupRecordCallIdx = content.indexOf("dedup_record \"$fingerprint\"");
        expect(postSlackIdx).toBeGreaterThan(-1);
        expect(dedupRecordCallIdx).toBeGreaterThan(-1);
        expect(dedupRecordCallIdx).toBeGreaterThan(postSlackIdx);
      },
    );

    it.each([
      "hermes-watchdog.sh",
      "ai.agento.health-guardian.sh",
    ])(
      "%s leaves DEDUPE_FILE absent when post_slack fails (empty channel)",
      (scriptName) => {
        // Run the actual dedup+post flow with empty CHANNEL and a token
        // already in env. The script's post_slack returns 1 (no channel),
        // and dedup_record must NOT be called — so the dedupe file is
        // never created. With the old buggy code, the file would be
        // written by dedup_should_send before the post.
        const tempDir = mkdtempSync(join(tmpdir(), "wd-routing-dedup-"));
        const dedupeFile = join(tempDir, "last_alert.sha");
        // Strip the script down to: DEDUPE_FILE, dedup_already_sent,
        // dedup_record, post_slack stub returning 1, and the alert flow.
        // We run a snippet in bash that sources the helpers and exercises
        // the flow. The heredoc uses `set +e` so the post's return 1
        // doesn't abort the snippet.
        const scriptPath = join(repoRoot, "scripts", scriptName);
        const fullContent = readFileSync(scriptPath, "utf-8");
        const dedupeAssign = fullContent.match(/^DEDUPE_FILE=.*$/m);
        expect(dedupeAssign).not.toBeNull();
        const dedupCheck = fullContent.match(/^dedup_already_sent\(\) \{[\s\S]*?^\}/m);
        const dedupRec = fullContent.match(/^dedup_record\(\) \{[\s\S]*?^\}/m);
        expect(dedupCheck).not.toBeNull();
        expect(dedupRec).not.toBeNull();
        // Stub post_slack to always fail (mimics empty-channel / no-token
        // / network-error). This is the condition the regression hits.
        const snippet = [
          "set +e",
          `DEDUPE_FILE='${dedupeFile}'`,
          // stub post_slack to return 1 (mimic the empty-channel guard)
          "post_slack() { return 1; }",
          dedupCheck![0],
          dedupRec![0],
          "fingerprint='test-fingerprint-12345'",
          "if dedup_already_sent \"$fingerprint\"; then",
          "  echo SUPPRESSED",
          "elif post_slack \"dummy\"; then",
          "  dedup_record \"$fingerprint\"",
          "  echo POSTED",
          "else",
          "  echo NOT_DELIVERED",
          "fi",
        ].join("\n");
        const stdout = execSync("bash", { input: snippet }).toString().trim();
        expect(stdout).toBe("NOT_DELIVERED");
        // The dedupe file must not exist — fingerprint is not recorded
        // when the post fails.
        expect(existsSync(dedupeFile)).toBe(false);
      },
    );
  });
});
