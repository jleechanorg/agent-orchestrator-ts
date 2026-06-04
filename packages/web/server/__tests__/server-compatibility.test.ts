/**
 * Server compatibility tests.
 *
 * These verify that the terminal server files import shared utilities
 * from tmux-utils.ts and don't contain deprecated patterns from the
 * pre-hash-based architecture (config.dataDir, loadConfig, existsSync).
 *
 * For actual behavioral tests of the shared utilities, see tmux-utils.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET } from "../../src/app/api/sessions/route";

vi.mock("@/lib/services", () => {
  return {
    getServices: vi.fn().mockResolvedValue({
      config: { projects: {} },
      registry: { get: vi.fn() },
      sessionManager: {
        list: vi.fn().mockResolvedValue([]),
      },
    }),
    getSCM: vi.fn(),
  };
});

const serverDir = join(__dirname, "..");

function readServerFile(name: string): string {
  return readFileSync(join(serverDir, name), "utf-8");
}

describe("direct-terminal-ws.ts", () => {
  const source = readServerFile("direct-terminal-ws.ts");

  it("imports from shared tmux-utils", () => {
    expect(source).toMatch(/from\s+["']\.\/tmux-utils/);
  });

  it("does not import loadConfig from @jleechanorg/ao-core", () => {
    expect(source).not.toMatch(/import\s.*loadConfig.*from\s+["']@composio\/ao-core["']/);
  });

  it("does not reference config.dataDir", () => {
    expect(source).not.toMatch(/config\.dataDir/);
  });

  it("does not use bare 'tmux' string for ptySpawn", () => {
    expect(source).not.toMatch(/ptySpawn\(\s*["']tmux["']/);
  });

  it("does not check file existence for session validation", () => {
    expect(source).not.toMatch(/existsSync.*session/i);
  });

  it("exposes terminal health metrics in /health response", () => {
    expect(source).toMatch(/metrics/);
    expect(source).toMatch(/totalConnections/);
    expect(source).toMatch(/totalDisconnects/);
    expect(source).toMatch(/totalErrors/);
  });

  it("specifies noServer in WebSocketServer to prevent onboarding TypeError", () => {
    expect(source).toMatch(/new\s+WebSocketServer\(\{\s*(noServer:\s*true\b|.*noServer:\s*true)/);
  });
});

describe("terminal-websocket.ts", () => {
  const source = readServerFile("terminal-websocket.ts");

  it("imports from shared tmux-utils", () => {
    expect(source).toMatch(/from\s+["']\.\/tmux-utils/);
  });

  it("does not import loadConfig from @jleechanorg/ao-core", () => {
    expect(source).not.toMatch(/import\s.*loadConfig.*from\s+["']@composio\/ao-core["']/);
  });

  it("does not reference config.dataDir", () => {
    expect(source).not.toMatch(/config\.dataDir/);
  });

  it("does not check file existence for session validation", () => {
    expect(source).not.toMatch(/existsSync.*session/i);
  });

  it("kills child process trees during shutdown", () => {
    expect(source).toMatch(/killProcessTree/);
    expect(source).toMatch(/spawnManagedDaemonChild/);
    expect(source).toMatch(/detached:\s*!\s*isWindows\(\)/);
  });
});

describe("OrchestratorConfig compatibility", () => {
  it("OrchestratorConfig does not have dataDir property", () => {
    const typesSource = readFileSync(
      join(__dirname, "..", "..", "..", "core", "src", "types.ts"),
      "utf-8",
    );

    const configMatch = typesSource.match(/export interface OrchestratorConfig \{[\s\S]*?\n\}/);
    expect(configMatch).toBeTruthy();
    const configBlock = configMatch![0];

    expect(configBlock).not.toMatch(/dataDir/);
    expect(configBlock).toMatch(/configPath/);
  });
});

describe("sessions API route", () => {
  it("implements robust typesafe limit parameter checks", () => {
    const routeSource = readFileSync(
      join(__dirname, "..", "..", "src", "app", "api", "sessions", "route.ts"),
      "utf-8",
    );
    expect(routeSource).toMatch(/typeof limit ===\s*["']number["']\s*&&\s*!isNaN\(limit\)/);
  });

  it("behaviorally handles limit=0 gracefully at runtime by falling back to safe default page limit of 1", async () => {
    const request = new Request("http://localhost/api/sessions?limit=0");
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("sessions");
    expect(data.sessions).toBeInstanceOf(Array);
    // Since limit=0 is passed, we expect it to fall back to the minimum limit of 1
    expect(data.pagination).toBeDefined();
    expect(data.pagination.limit).toBe(1);
  });
});

