import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleManager, OrchestratorConfig, PluginRegistry, Session, SessionManager } from "../types.js";

const mocks = vi.hoisted(() => ({
  home: "", productivity: vi.fn(), clearPause: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(), homedir: () => mocks.home,
}));
vi.mock("../productivity-checker.js", () => ({ runProductivityChecks: mocks.productivity }));
vi.mock("../tmux-session-sweeper.js", () => ({
  DEFAULT_TMUX_SWEEPER_CONFIG: { aoSessionPrefixes: new Set() },
  sweepOrphanTmuxSessions: vi.fn().mockResolvedValue({ killed: [], errors: [] }),
}));
vi.mock("../session-reaper.js", () => ({
  DEFAULT_REAPER_CONFIG: {},
  reapStaleSessions: vi.fn().mockResolvedValue({ killed: [], skipped: [], errors: [] }),
}));
vi.mock("../lifecycle-project-crons.js", () => ({
  runLifecycleProjectCrons: vi.fn().mockResolvedValue(undefined),
  maybeWarnBackfillDisabledWithOpenPRs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../session-exit-proof.js", () => ({ validateAndEmitExitProof: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../skeptic-cron-local.js", () => ({ runLocalSkepticCron: vi.fn().mockResolvedValue(0) }));
vi.mock("../mcp-mail.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mcp-mail.js")>(), getMcpMailClientConfig: () => undefined,
}));
vi.mock("../fork-lifecycle-manager.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../fork-lifecycle-manager.js")>(), clearProjectPause: mocks.clearPause,
}));
import { reapStaleSessions } from "../session-reaper.js";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { getSessionsDir } from "../paths.js";
import { writeMetadata } from "../metadata.js";
import { GLOBAL_PAUSE_UNTIL_KEY as UNTIL, GLOBAL_PAUSE_REASON_KEY as REASON } from "../global-pause.js";

let manager: LifecycleManager | undefined;
afterEach(() => {
  manager?.stop(); manager = undefined;
  if (mocks.home) rmSync(mocks.home, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function run(metadata: Record<string, string>): Promise<SessionManager> {
  mocks.home = mkdtempSync(join(tmpdir(), "ao-scoped-pause-test-"));
  const configPath = join(mocks.home, "config.yaml");
  writeFileSync(configPath, "projects: {}\n");
  const project = { name: "app", path: mocks.home, repo: "test/app", defaultBranch: "main", sessionPrefix: "app" };
  const config = { configPath, defaults: { notifiers: [] }, notificationRouting: {}, projects: { app: project }, reactions: {} } as unknown as OrchestratorConfig;
  const session = (id: string, agent: string, status: Session["status"] = "spawning"): Session => ({
    id, projectId: "app", status, activity: "active", branch: "test", issueId: null, pr: null,
    workspacePath: mocks.home, runtimeHandle: null, agentInfo: null,
    createdAt: new Date(), lastActivityAt: new Date(), metadata: { agent },
  });
  const orchestrator = session("app-orchestrator", "");
  orchestrator.metadata = { ...metadata, role: "orchestrator" };
  writeMetadata(getSessionsDir(configPath, project.path), orchestrator.id, { ...metadata, status: "spawning" });
  const sessions = [orchestrator, session("app-claude", "claude"), session("app-gemini", "gemini"), session("app-no-agent", ""), session("app-terminal", "claude", "done")];
  const sm = { list: vi.fn().mockResolvedValue(sessions), get: vi.fn().mockResolvedValue(null), kill: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined), cleanup: vi.fn() } as unknown as SessionManager;
  const registry = { get: vi.fn().mockReturnValue(null), list: vi.fn().mockReturnValue([]) } as unknown as PluginRegistry;
  mocks.productivity.mockResolvedValue(undefined);
  manager = createLifecycleManager({ config, sessionManager: sm, registry });
  manager.start(60_000);
  await vi.waitUntil(() => mocks.productivity.mock.calls.length > 0);
  await vi.waitUntil(() => vi.mocked(reapStaleSessions).mock.calls.length > 0);
  return sm;
}

describe("agent-scoped pause lifecycle routing (offline mocked resources)", () => {
  it("skips only the paused agent and keeps other agents productive", async () => {
    const sm = await run({
      [`${UNTIL}_claude`]: new Date(Date.now() + 60_000).toISOString(),
      [`${UNTIL}_expired`]: new Date(Date.now() - 60_000).toISOString(),
      [`${REASON}_expired`]: "expired limit", [`${UNTIL}_invalid`]: "invalid date", other: "ignored",
    });
    expect(mocks.productivity.mock.calls[0][0].map((s: Session) => s.id)).toEqual(["app-orchestrator", "app-gemini", "app-no-agent"]);
    expect(mocks.clearPause).toHaveBeenCalledWith(expect.any(String), expect.any(Object), "expired");
    expect(sm.kill).toHaveBeenCalledExactlyOnceWith("app-terminal");
  });

  it("preserves a global pause for all agents", async () => {
    const sm = await run({ [UNTIL]: new Date(Date.now() + 60_000).toISOString() });
    expect(mocks.productivity.mock.calls[0][0]).toEqual([]);
    expect(sm.kill).toHaveBeenCalledExactlyOnceWith("app-terminal");
  });
});
