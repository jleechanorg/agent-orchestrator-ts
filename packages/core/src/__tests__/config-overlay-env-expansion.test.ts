import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

// Regression test for the standalone slack notifier receiving an unexpanded
// ${SLACK_WEBHOOK_URL:-...PLACEHOLDER} template from a repo-local overlay.
//
// Before the fix, mergeConfigOverlay() parsed the overlay YAML without calling
// expandEnvVars(), so an unexpanded template in the overlay won the deep-merge
// against the primary config's already-expanded value, leaving the slack
// notifier with webhookUrl containing the literal PLACEHOLDER string and
// causing "[notifier-slack] Ignoring unresolved webhookUrl placeholder" in
// `ao status`.
//
// After the fix, parseYaml(overlayRaw) is wrapped with expandEnvVars() so any
// ${VAR} templates in the overlay are expanded before the deep-merge —
// matching the behavior the primary config already had via loadConfig's
// earlier expandEnvVars call.
//
// bd-feedback-2026-06-19-notif-slack-placeholder
// See PR #715: https://github.com/jleechanorg/agent-orchestrator/pull/715

const originalHome = process.env["HOME"];
const originalCwd = process.cwd();
const originalStagingPath = process.env["AO_STAGING_CONFIG_PATH"];
const originalProdPath = process.env["AO_PROD_CONFIG_PATH"];
const originalConfigPath = process.env["AO_CONFIG_PATH"];
const originalSlackWebhookUrl = process.env["SLACK_WEBHOOK_URL"];
const tempDirs: string[] = [];

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  if (originalStagingPath === undefined) {
    delete process.env["AO_STAGING_CONFIG_PATH"];
  } else {
    process.env["AO_STAGING_CONFIG_PATH"] = originalStagingPath;
  }
  if (originalProdPath === undefined) {
    delete process.env["AO_PROD_CONFIG_PATH"];
  } else {
    process.env["AO_PROD_CONFIG_PATH"] = originalProdPath;
  }
  if (originalConfigPath === undefined) {
    delete process.env["AO_CONFIG_PATH"];
  } else {
    process.env["AO_CONFIG_PATH"] = originalConfigPath;
  }
  if (originalSlackWebhookUrl === undefined) {
    delete process.env["SLACK_WEBHOOK_URL"];
  } else {
    process.env["SLACK_WEBHOOK_URL"] = originalSlackWebhookUrl;
  }
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MANAGED_CONFIG = `
defaults:
  runtime: tmux
  agent: claude-code
projects: {}
notifiers: {}
`;

const REPO_LOCAL_OVERLAY_WITH_UNEXPANDED_TEMPLATE = `
notifiers:
  slack:
    plugin: slack
    webhookUrl: "\${SLACK_WEBHOOK_URL:-https://hooks.slack.com/services/PLACEHOLDER}"
`;

describe("loadConfig: repo-local overlay env expansion (PR #715)", () => {
  it("expands ${SLACK_WEBHOOK_URL:-...} in repo-local overlay before merging", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-overlay-env-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-overlay-env-work-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "agent-orchestrator.yaml"),
      MANAGED_CONFIG,
      "utf-8",
    );
    writeFileSync(
      join(work, "agent-orchestrator.yaml"),
      REPO_LOCAL_OVERLAY_WITH_UNEXPANDED_TEMPLATE,
      "utf-8",
    );

    process.env["HOME"] = home;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    delete process.env["AO_PROD_CONFIG_PATH"];
    delete process.env["AO_CONFIG_PATH"];
    process.env["SLACK_WEBHOOK_URL"] = "https://hooks.slack.com/services/TEST/REAL/abc";
    process.chdir(work);

    const config = loadConfig();
    const notifiers = config.notifiers as Record<string, Record<string, unknown>>;
    const slackWebhookUrl = notifiers.slack?.webhookUrl as string;

    // The overlay's ${...} template must be expanded BEFORE the deep-merge so
    // the notifier receives the real URL, not the literal ${SLACK_WEBHOOK_URL:-PLACEHOLDER}.
    expect(slackWebhookUrl).toBe("https://hooks.slack.com/services/TEST/REAL/abc");
    expect(slackWebhookUrl).not.toContain("PLACEHOLDER");
    expect(slackWebhookUrl).not.toMatch(/\$\{/);
  });

  it("falls back to the default after the :- when SLACK_WEBHOOK_URL is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-overlay-env-home-fallback-"));
    const work = mkdtempSync(join(tmpdir(), "ao-overlay-env-work-fallback-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "agent-orchestrator.yaml"),
      MANAGED_CONFIG,
      "utf-8",
    );
    writeFileSync(
      join(work, "agent-orchestrator.yaml"),
      REPO_LOCAL_OVERLAY_WITH_UNEXPANDED_TEMPLATE,
      "utf-8",
    );

    process.env["HOME"] = home;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    delete process.env["AO_PROD_CONFIG_PATH"];
    delete process.env["AO_CONFIG_PATH"];
    delete process.env["SLACK_WEBHOOK_URL"];
    process.chdir(work);

    const config = loadConfig();
    const notifiers = config.notifiers as Record<string, Record<string, unknown>>;
    const slackWebhookUrl = notifiers.slack?.webhookUrl as string;

    // The ${VAR:-default} syntax should fall back to the default when the env
    // var is unset — the expansion itself is what was missing in the overlay path.
    expect(slackWebhookUrl).toBe(
      "https://hooks.slack.com/services/PLACEHOLDER",
    );
    expect(slackWebhookUrl).not.toMatch(/^\$\{/);
  });
});
