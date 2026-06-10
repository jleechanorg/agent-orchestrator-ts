import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";

const {
  mockConfigRef,
  mockWaitForPortAndOpen,
  mockSpawn,
  mockFindRunningDashboardPid,
  mockFindProcessWebDir,
} = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockWaitForPortAndOpen: vi.fn().mockResolvedValue(undefined),
  mockSpawn: vi.fn(),
  mockFindRunningDashboardPid: vi.fn().mockResolvedValue(null),
  mockFindProcessWebDir: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: vi.fn(),
  exec: vi.fn(),
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: vi.fn().mockResolvedValue([]),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("@jleechanorg/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jleechanorg/ao-core")>();
  return {
    ...actual,
    loadConfig: () => {
      return mockConfigRef.current;
    },
  };
});

vi.mock("../../src/lib/web-dir.js", () => ({
  findWebDir: vi.fn().mockReturnValue("/fake/web"),
  buildDashboardEnv: vi.fn().mockResolvedValue({}),
  waitForPortAndOpen: (...args: unknown[]) => mockWaitForPortAndOpen(...args),
  isPortAvailable: vi.fn().mockResolvedValue(true),
  findFreePort: vi.fn().mockResolvedValue(3000),
}));

vi.mock("../../src/lib/dashboard-rebuild.js", () => ({
  cleanNextCache: vi.fn(),
  findRunningDashboardPid: (...args: unknown[]) => mockFindRunningDashboardPid(...args),
  findProcessWebDir: (...args: unknown[]) => mockFindProcessWebDir(...args),
  waitForPortFree: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

import { Command } from "commander";
import { registerDashboard } from "../../src/commands/dashboard.js";

let tmpDir: string;
let program: Command;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-dashboard-open-test-"));
  originalEnv = { ...process.env };
  process.env["AO_CONFIG_PATH"] = join(tmpDir, "agent-orchestrator.yaml");

  program = new Command();
  program.exitOverride();
  registerDashboard(program);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  const fakeChild = { on: vi.fn(), kill: vi.fn(), emit: vi.fn(), stdout: null, stderr: { on: vi.fn() } };
  mockSpawn.mockReturnValue(fakeChild);

  mockWaitForPortAndOpen.mockReset();
  mockWaitForPortAndOpen.mockResolvedValue(undefined);
  mockFindRunningDashboardPid.mockReset();
  mockFindRunningDashboardPid.mockResolvedValue(null);
  mockFindProcessWebDir.mockReset();
  mockFindProcessWebDir.mockResolvedValue(null);
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeConfig(configOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const config = {
    configPath: join(tmpDir, "agent-orchestrator.yaml"),
    port: 3000,
    ...configOverrides,
  };

  writeFileSync(config.configPath, yamlStringify(config, { indent: 2 }));
  return config;
}

describe("dashboard command — browser open regression tests (bd-#667)", () => {
  it("skips browser open when AO_NO_OPEN_BROWSER env var is set to 1", async () => {
    const prev = process.env["AO_NO_OPEN_BROWSER"];
    process.env["AO_NO_OPEN_BROWSER"] = "1";
    try {
      mockConfigRef.current = makeConfig();

      await program.parseAsync(["node", "test", "dashboard"]);

      expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env["AO_NO_OPEN_BROWSER"];
      else process.env["AO_NO_OPEN_BROWSER"] = prev;
    }
  });

  it("skips browser open when AO_NO_OPEN_BROWSER env var is set to true", async () => {
    const prev = process.env["AO_NO_OPEN_BROWSER"];
    process.env["AO_NO_OPEN_BROWSER"] = "true";
    try {
      mockConfigRef.current = makeConfig();

      await program.parseAsync(["node", "test", "dashboard"]);

      expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env["AO_NO_OPEN_BROWSER"];
      else process.env["AO_NO_OPEN_BROWSER"] = prev;
    }
  });

  it("skips browser open when openBrowser: false in YAML config", async () => {
    mockConfigRef.current = makeConfig({ openBrowser: false });

    await program.parseAsync(["node", "test", "dashboard"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
  });

  it("skips browser open when --no-open CLI flag is set", async () => {
    mockConfigRef.current = makeConfig();

    await program.parseAsync(["node", "test", "dashboard", "--no-open"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
  });

  it("skips browser open when --no-open-browser CLI flag is set", async () => {
    mockConfigRef.current = makeConfig();

    await program.parseAsync(["node", "test", "dashboard", "--no-open-browser"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
  });

  it("still calls waitForPortAndOpen when no suppression is set", async () => {
    const prev = process.env["AO_NO_OPEN_BROWSER"];
    delete process.env["AO_NO_OPEN_BROWSER"];
    try {
      mockConfigRef.current = makeConfig();

      await program.parseAsync(["node", "test", "dashboard"]);

      expect(mockWaitForPortAndOpen).toHaveBeenCalledTimes(1);
    } finally {
      if (prev !== undefined) process.env["AO_NO_OPEN_BROWSER"] = prev;
    }
  });
});
