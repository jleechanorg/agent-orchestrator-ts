/**
 * Integration test: openclaw notifier config → plugin-registry resolution.
 * Verifies the full config-to-plugin path for ORCH-6ae.
 *
 * Uses the real notifier-openclaw plugin module imported directly, so we can
 * test the actual Notifier instance (not a fake). fetch is stubbed globally
 * to avoid real HTTP calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPluginRegistry } from "../plugin-registry.js";
import notifierOpenclaw from "@jleechanorg/ao-plugin-notifier-openclaw";
import type { Notifier, OrchestratorConfig } from "../types.js";

describe("OpenClaw notifier config integration", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENCLAW_HOOKS_TOKEN;
  });

  function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
    return {
      port: 3000,
      terminalPort: undefined,
      directTerminalPort: undefined,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["desktop", "openclaw"],
        orchestrator: undefined,
        worker: undefined,
      },
      notifiers: {
        openclaw: {
          plugin: "openclaw",
          token: "test-token",
          url: "http://127.0.0.1:18789/hooks/agent",
          sessionKeyPrefix: "hook:ao:",
        },
      },
      notificationRouting: {
        urgent: ["desktop", "openclaw"],
        action: ["desktop", "openclaw"],
        warning: ["openclaw"],
        info: [],
      },
      reactions: {},
      projects: {
        "test-app": {
          name: "Test App",
          repo: "org/test-app",
          path: "/tmp/test-app",
          defaultBranch: "main",
          agentConfig: { permissions: "permissionless" },
          orchestrator: undefined,
          worker: undefined,
        },
      },
      ...overrides,
    } as OrchestratorConfig;
  }

  it("resolves openclaw notifier from defaults.notifiers + notifiers config", async () => {
    const config = makeConfig();
    const registry = createPluginRegistry();
    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@jleechanorg/ao-plugin-notifier-openclaw") return notifierOpenclaw;
      throw new Error(`Not found: ${pkg}`);
    });
    const notifier = registry.get<Notifier>("notifier", "openclaw");
    expect(notifier).not.toBeNull();
    expect(notifier!.name).toBe("openclaw");
  });

  it("creates openclaw notifier with token from config", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig();
    const registry = createPluginRegistry();
    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@jleechanorg/ao-plugin-notifier-openclaw") return notifierOpenclaw;
      throw new Error(`Not found: ${pkg}`);
    });
    const notifier = registry.get<Notifier>("notifier", "openclaw");

    await notifier!.notify({
      id: "evt-1",
      type: "reaction.escalated",
      priority: "urgent",
      sessionId: "ao-5",
      projectId: "ao",
      timestamp: new Date(),
      message: "Agent stuck",
      data: {},
    });

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("creates openclaw notifier using OPENCLAW_HOOKS_TOKEN env when no token in config", async () => {
    process.env.OPENCLAW_HOOKS_TOKEN = "env-tok";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({
      notifiers: {
        openclaw: {
          plugin: "openclaw",
          // no token field — should fall back to env
        },
      },
    } as Partial<OrchestratorConfig>);
    const registry = createPluginRegistry();
    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@jleechanorg/ao-plugin-notifier-openclaw") return notifierOpenclaw;
      throw new Error(`Not found: ${pkg}`);
    });
    const notifier = registry.get<Notifier>("notifier", "openclaw");

    await notifier!.notify({
      id: "evt-2",
      type: "reaction.escalated",
      priority: "urgent",
      sessionId: "ao-6",
      projectId: "ao",
      timestamp: new Date(),
      message: "stuck",
      data: {},
    });

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer env-tok");
  });

  it("session key uses hook:ao: prefix from config", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig();
    const registry = createPluginRegistry();
    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@jleechanorg/ao-plugin-notifier-openclaw") return notifierOpenclaw;
      throw new Error(`Not found: ${pkg}`);
    });
    const notifier = registry.get<Notifier>("notifier", "openclaw");

    await notifier!.notify({
      id: "evt-3",
      type: "reaction.escalated",
      priority: "urgent",
      sessionId: "ao-12",
      projectId: "ao",
      timestamp: new Date(),
      message: "stuck",
      data: {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sessionKey).toBe("hook:ao:ao-12");
  });
});
