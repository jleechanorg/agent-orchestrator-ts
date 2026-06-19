import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetEnvBootstrapForTesting, loadConfig } from "../config.js";

// Regression test for the standalone slack notifier receiving an unexpanded
// ${SLACK_WEBHOOK_URL:-...PLACEHOLDER} template from a repo-local overlay.
//
// Two distinct gaps are covered:
//
// 1. Overlay merge: parseYaml(overlayRaw) is wrapped with expandEnvVars() so any
//    ${VAR} templates in the overlay are expanded before the deep-merge —
//    matching the behavior the primary config already had via loadConfig's
//    earlier expandEnvVars call.
//
// 2. EnvSource bootstrap order + overlay-override: bootstrapEnvSource now runs
//    BEFORE expandEnvVars, using the MERGED view of envSource (primary
//    deep-merged with overlay). This means a repo-local overlay can override
//    `defaults.envSource` (e.g. switch from ~/.bashrc to ~/.zshrc) and the
//    overlay's own ${VAR} templates will see vars sourced from the overridden
//    envSource, not from the primary config's envSource. Without this, a
//    daemon launched via launchd (which does not inherit shell init files)
//    freezes ${SLACK_WEBHOOK_URL} to its :- fallback and the sourced value
//    never replaces the frozen string.
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

beforeEach(() => {
  // loadConfig sets a module-level "bootstrap done" flag on first call; reset
  // it so each test re-bootstraps envSource from process.env + configured
  // envSource files (otherwise the third test sees a stale flag from the first).
  _resetEnvBootstrapForTesting();
});

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

const REPO_LOCAL_OVERLAY_WITH_OVERRIDE_ENVSOURCE = `
defaults:
  envSource:
    - "~/.zshrc"
notifiers:
  slack:
    plugin: slack
    webhookUrl: "\${SLACK_WEBHOOK_URL_FROM_ZSH:-https://hooks.slack.com/services/PLACEHOLDER}"
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

  it("expands ${SLACK_WEBHOOK_URL} from ~/.bashrc (envSource bootstrap before overlay merge)", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-overlay-envsource-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-overlay-envsource-work-"));
    tempDirs.push(home, work);

    // Write a fake ~/.bashrc that exports SLACK_WEBHOOK_URL — simulates the
    // user-managed credential that a launchd-managed daemon cannot inherit
    // directly from the calling shell. The trusted-default envSource path
    // (`~/.bashrc`) is what bootstrapEnvSource reads to populate process.env.
    writeFileSync(
      join(home, ".bashrc"),
      `export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/FROM_BASHRC/abc/123"\n`,
      "utf-8",
    );

    // Primary config under ~/.hermes/agent-orchestrator.yaml — the trusted
    // envSource default is `~/.bashrc`, which will be sourced before expansion.
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "agent-orchestrator.yaml"),
      MANAGED_CONFIG,
      "utf-8",
    );

    // Repo-local overlay uses the ${VAR} template — this is the regression
    // scenario: SLACK_WEBHOOK_URL is not in process.env at loadConfig time
    // because the test process never sourced ~/.bashrc directly; only
    // bootstrapEnvSource can populate it.
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

    // The Slack notifier must receive the URL from ~/.bashrc, NOT the
    // :-PLACEHOLDER fallback. If bootstrapEnvSource runs after expandEnvVars,
    // the overlay freezes PLACEHOLDER and the sourced value is never applied.
    expect(slackWebhookUrl).toBe(
      "https://hooks.slack.com/services/FROM_BASHRC/abc/123",
    );
    expect(slackWebhookUrl).not.toContain("PLACEHOLDER");
    expect(slackWebhookUrl).not.toMatch(/\$\{/);
  });

  it("honors repo-local overlay-defined envSource (re-bootstrap after merge)", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-overlay-override-envsource-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-overlay-override-envsource-work-"));
    tempDirs.push(home, work);

    // The primary config will source ~/.bashrc by default (no SLACK_* vars
    // there). The repo-local overlay overrides envSource to ~/.zshrc, which
    // DOES define SLACK_WEBHOOK_URL_FROM_ZSH. After the merge, the merged
    // envSource is [~/.zshrc], so re-bootstrapping from the merged config
    // must source ~/.zshrc and populate the var before the overlay's
    // ${SLACK_WEBHOOK_URL_FROM_ZSH:-...} fallback freezes.
    writeFileSync(join(home, ".bashrc"), "# primary bashrc — no SLACK vars here\n", "utf-8");
    writeFileSync(
      join(home, ".zshrc"),
      `export SLACK_WEBHOOK_URL_FROM_ZSH="https://hooks.slack.com/services/FROM_ZSHRC/xyz/789"\n`,
      "utf-8",
    );

    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "agent-orchestrator.yaml"),
      MANAGED_CONFIG,
      "utf-8",
    );
    writeFileSync(
      join(work, "agent-orchestrator.yaml"),
      REPO_LOCAL_OVERLAY_WITH_OVERRIDE_ENVSOURCE,
      "utf-8",
    );

    process.env["HOME"] = home;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    delete process.env["AO_PROD_CONFIG_PATH"];
    delete process.env["AO_CONFIG_PATH"];
    delete process.env["SLACK_WEBHOOK_URL_FROM_ZSH"];
    process.chdir(work);

    const config = loadConfig();
    const notifiers = config.notifiers as Record<string, Record<string, unknown>>;
    const slackWebhookUrl = notifiers.slack?.webhookUrl as string;

    // The merged envSource [~/.zshrc] must be honored, so SLACK_WEBHOOK_URL_FROM_ZSH
    // is sourced from ~/.zshrc and the overlay's ${VAR} expands to the real URL.
    expect(slackWebhookUrl).toBe(
      "https://hooks.slack.com/services/FROM_ZSHRC/xyz/789",
    );
    expect(slackWebhookUrl).not.toContain("PLACEHOLDER");
    expect(slackWebhookUrl).not.toMatch(/\$\{/);
  });
});
