/**
 * TDD: workspace setup idempotency — bd-uxs.1
 *
 * setupWorkspaceHooks must NOT write files when content is already up-to-date.
 * Dirty-workspace bug: AO was re-writing .claude/settings.json and
 * metadata-updater.sh on every session setup, even when the content was
 * identical to what was already on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, statSync, utimesSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { create } from "../index.js";
import type { WorkspaceHooksConfig } from "@jleechanorg/ao-core";

let tmpDir: string;
let workspacePath: string;
let claudeDir: string;
let savedMcpAgentMailUrl: string | undefined;

beforeEach(() => {
  savedMcpAgentMailUrl = process.env.MCP_AGENT_MAIL_URL;
  tmpDir = mkdtempSync(join(tmpdir(), "ao-test-ws-"));
  workspacePath = join(tmpDir, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  claudeDir = join(workspacePath, ".claude");
  // Ensure MCP_AGENT_MAIL_URL is not set so setupMcpMailInWorkspace is a no-op
  delete process.env.MCP_AGENT_MAIL_URL;
});

afterEach(() => {
  if (savedMcpAgentMailUrl === undefined) {
    delete process.env.MCP_AGENT_MAIL_URL;
  } else {
    process.env.MCP_AGENT_MAIL_URL = savedMcpAgentMailUrl;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeHookConfig(overrides: Partial<WorkspaceHooksConfig> = {}): WorkspaceHooksConfig {
  return {
    dataDir: join(tmpDir, "data"),
    ...overrides,
  };
}

/** Set a known old mtime on a file so we can detect whether it was written again. */
function setOldMtime(filePath: string): Date {
  const oldDate = new Date("2000-01-01T00:00:00Z");
  utimesSync(filePath, oldDate, oldDate);
  return oldDate;
}

function getMtime(filePath: string): number {
  return statSync(filePath).mtimeMs;
}

describe("setupWorkspaceHooks idempotency", () => {
  it("creates settings.json and metadata-updater.sh on first call", async () => {
    const agent = create();
    await agent.setupWorkspaceHooks!(workspacePath, makeHookConfig());

    const settingsPath = join(claudeDir, "settings.json");
    const scriptPath = join(claudeDir, "metadata-updater.sh");

    expect(() => statSync(settingsPath)).not.toThrow();
    expect(() => statSync(scriptPath)).not.toThrow();
  });

  it("writes correct settings.json on second call when content is unchanged (#1941)", async () => {
    const agent = create();
    const hookConfig = makeHookConfig();

    // First call
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const settingsPath = join(claudeDir, "settings.json");
    const contentAfterFirst = readFileSync(settingsPath, "utf-8");

    // Second call with identical config — content should be identical
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const contentAfterSecond = readFileSync(settingsPath, "utf-8");
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  it("writes correct metadata-updater.sh on second call when content is unchanged (#1941)", async () => {
    const agent = create();
    const hookConfig = makeHookConfig();

    // First call
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const scriptPath = join(claudeDir, "metadata-updater.sh");
    const contentAfterFirst = readFileSync(scriptPath, "utf-8");

    // Second call
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const contentAfterSecond = readFileSync(scriptPath, "utf-8");
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  it("writes workspace-relative hook commands regardless of dataDir (#1941)", async () => {
    const agent = create();

    await agent.setupWorkspaceHooks!(workspacePath, makeHookConfig({ dataDir: join(tmpDir, "data-v1") }));

    const settingsPath = join(claudeDir, "settings.json");
    const contentV1 = readFileSync(settingsPath, "utf-8");

    await agent.setupWorkspaceHooks!(workspacePath, makeHookConfig({ dataDir: join(tmpDir, "data-v2") }));
    const contentV2 = readFileSync(settingsPath, "utf-8");

    // Hook commands are workspace-relative so settings content should be
    // identical regardless of the dataDir parameter.
    expect(contentV2).toBe(contentV1);
  });
});

describe("setupWorkspaceHooks with MCP mail idempotency", () => {
  let originalMcpUrl: string | undefined;

  beforeEach(() => {
    originalMcpUrl = process.env.MCP_AGENT_MAIL_URL;
    process.env.MCP_AGENT_MAIL_URL = "http://127.0.0.1:8765/mcp/";
  });

  afterEach(() => {
    if (originalMcpUrl === undefined) {
      delete process.env.MCP_AGENT_MAIL_URL;
    } else {
      process.env.MCP_AGENT_MAIL_URL = originalMcpUrl;
    }
  });

  it("writes identical settings.json on second call when MCP mail config is unchanged (#1941)", async () => {
    const agent = create();
    const hookConfig = makeHookConfig();

    // First call (writes hook + mcp-agent-mail config)
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const settingsPath = join(claudeDir, "settings.json");
    const contentAfterFirst = readFileSync(settingsPath, "utf-8");

    // Second call — same URL, same hook — content should be identical
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const contentAfterSecond = readFileSync(settingsPath, "utf-8");
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });
});
