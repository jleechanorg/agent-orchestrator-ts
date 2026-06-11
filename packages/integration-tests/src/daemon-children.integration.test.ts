import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWindows, killProcessTree } from "@jleechanorg/ao-core";
import { sleep } from "./helpers/polling.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/index.ts");
const tsxBin = join(repoRoot, "packages/cli/node_modules/.bin/tsx");
const dashboardEntry = join(repoRoot, "packages/web/dist-server/start-all.js");

const canRun = !isWindows() && existsSync(tsxBin) && existsSync(dashboardEntry);

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a free port"));
      });
    });
  });
}

function findLifecycleLog(dir: string): string | null {
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const fullPath = join(dir, file);
      if (statSync(fullPath).isDirectory()) {
        const found = findLifecycleLog(fullPath);
        if (found) return found;
      } else if (file === "lifecycle-worker.log") {
        return fullPath;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function findLifecyclePidFile(dir: string): string | null {
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const fullPath = join(dir, file);
      if (statSync(fullPath).isDirectory()) {
        const found = findLifecyclePidFile(fullPath);
        if (found) return found;
      } else if (file === "lifecycle-worker.pid") {
        return fullPath;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function readChildPids(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)]);
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "EPERM";
  }
}

describe.skipIf(!canRun)("daemon child reaping (integration)", () => {
  let tmpHome: string;
  let repoPath: string;
  let configPath: string;
  let startPid: number | undefined;
  let port: number;

  beforeEach(async () => {
    tmpHome = await realpath(await mkdtemp(join(tmpdir(), "ao-daemon-int-home-")));
    port = await getFreePort();
    repoPath = join(tmpHome, "repo");
    mkdirSync(repoPath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    writeFileSync(join(repoPath, "README.md"), "# daemon child reaping\n");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });

    configPath = join(repoPath, "agent-orchestrator.yaml");
    writeFileSync(
      configPath,
      ["runtime: process", "agent: claude-code", "workspace: worktree"].join("\n"),
    );

    const globalConfigPath = join(tmpHome, "global-agent-orchestrator.yaml");
    writeFileSync(
      globalConfigPath,
      [
        `port: ${port}`,
        "openBrowser: false",
        "defaults:",
        "  runtime: process",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  daemon-int:",
        "    displayName: Daemon Integration",
        `    path: ${JSON.stringify(repoPath)}`,
        "    defaultBranch: main",
        "    sessionPrefix: daemon-int",
      ].join("\n"),
    );
    configPath = globalConfigPath;
  }, 30_000);

  afterEach(async () => {
    try {
      const stopEnv = {
        ...process.env,
        HOME: tmpHome,
        AO_CALLER_TYPE: "agent",
        AO_CONFIG_PATH: configPath,
        AO_GLOBAL_CONFIG: configPath,
      };
      await execFileAsync(tsxBin, [cliEntry, "stop", "--all"], { cwd: repoPath, env: stopEnv, timeout: 10_000 });
    } catch {
      // ignore
    }
    if (startPid && isAlive(startPid)) {
      await killProcessTree(startPid, "SIGKILL");
    }
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("does not attempt to open the browser when suppressed", async () => {
    const binDir = join(tmpHome, "bin");
    mkdirSync(binDir, { recursive: true });
    const mockOpenPath = join(binDir, "open");
    const mockXdgOpenPath = join(binDir, "xdg-open");
    const mockOpenLog = join(tmpHome, "mock-open.log");

    const mockOpenScript = `#!/bin/sh\necho "$@" >> "${mockOpenLog}"\n`;
    writeFileSync(mockOpenPath, mockOpenScript, { mode: 0o755 });
    writeFileSync(mockXdgOpenPath, mockOpenScript, { mode: 0o755 });

    const env = {
      ...process.env,
      HOME: tmpHome,
      PATH: `${binDir}:${process.env.PATH}`,
      AO_CALLER_TYPE: "agent",
      AO_CONFIG_PATH: configPath,
      AO_GLOBAL_CONFIG: configPath,
      PORT: String(port),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    };

    // Verify config has openBrowser: false
    const configContent = readFileSync(configPath, "utf-8");
    expect(configContent).toContain("openBrowser: false");

    const logFd = openSync(join(tmpHome, "cli-start-1.log"), "w");
    const start = spawn(tsxBin, [cliEntry, "start", "--no-orchestrator", "--no-open-browser"], {
      cwd: repoPath,
      env,
      stdio: ["ignore", logFd, logFd],
    });
    startPid = start.pid;
    expect(startPid).toBeTypeOf("number");

    const runningPath = join(tmpHome, ".agent-orchestrator/running.json");
    let runningPid: number | undefined;
    for (let i = 0; i < 100; i++) {
      if (existsSync(runningPath)) {
        const running = JSON.parse(readFileSync(runningPath, "utf-8")) as { pid?: number };
        runningPid = running.pid;
        break;
      }
      await sleep(100);
    }
    if (!runningPid) {
      try {
        console.error("LOG 1 CONTENT (runningPid=undefined):\n", readFileSync(join(tmpHome, "cli-start-1.log"), "utf-8"));
        const lifecycleLog = findLifecycleLog(tmpHome);
        if (lifecycleLog) {
          console.error("LIFECYCLE WORKER LOG 1 CONTENT:\n", readFileSync(lifecycleLog, "utf-8"));
        }
      } catch (e) {
        console.error("Failed to read log 1:", e);
      }
    }
    expect(runningPid).toBeTypeOf("number");

    // Wait extra time for potential browser open attempts
    await sleep(2000);

    // Verify that our mock open was NEVER called
    expect(existsSync(mockOpenLog)).toBe(false);

    await execFileAsync(tsxBin, [cliEntry, "stop", "--all"], { cwd: repoPath, env, timeout: 20_000 });
  }, 60_000);

  it("attempts to open the browser when not suppressed", async () => {
    // Write config with openBrowser: true
    const configContent = readFileSync(configPath, "utf-8");
    const modifiedConfig = configContent.replace("openBrowser: false", "openBrowser: true");
    writeFileSync(configPath, modifiedConfig);

    const binDir = join(tmpHome, "bin");
    mkdirSync(binDir, { recursive: true });
    const mockOpenPath = join(binDir, "open");
    const mockXdgOpenPath = join(binDir, "xdg-open");
    const mockOpenLog = join(tmpHome, "mock-open.log");

    const mockOpenScript = `#!/bin/sh\necho "$@" >> "${mockOpenLog}"\n`;
    writeFileSync(mockOpenPath, mockOpenScript, { mode: 0o755 });
    writeFileSync(mockXdgOpenPath, mockOpenScript, { mode: 0o755 });

    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: tmpHome,
      PATH: `${binDir}:${process.env.PATH}`,
      AO_CALLER_TYPE: "agent",
      AO_CONFIG_PATH: configPath,
      AO_GLOBAL_CONFIG: configPath,
      PORT: String(port),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    };
    delete env.AO_NO_OPEN_BROWSER;

    const logFd = openSync(join(tmpHome, "cli-start-2.log"), "w");
    // Spawn without --no-open-browser flag
    const start = spawn(tsxBin, [cliEntry, "start", "--no-orchestrator"], {
      cwd: repoPath,
      env,
      stdio: ["ignore", logFd, logFd],
    });
    startPid = start.pid;

    const runningPath = join(tmpHome, ".agent-orchestrator/running.json");
    let runningPid: number | undefined;
    for (let i = 0; i < 100; i++) {
      if (existsSync(runningPath)) {
        const running = JSON.parse(readFileSync(runningPath, "utf-8")) as { pid?: number };
        runningPid = running.pid;
        break;
      }
      await sleep(100);
    }
    if (runningPid === undefined) {
      try {
        console.error("LOG 2 CONTENT:\n", readFileSync(join(tmpHome, "cli-start-2.log"), "utf-8"));
        const lifecycleLog = findLifecycleLog(tmpHome);
        if (lifecycleLog) {
          console.error("LIFECYCLE WORKER LOG 2 CONTENT:\n", readFileSync(lifecycleLog, "utf-8"));
        } else {
          console.error("LIFECYCLE WORKER LOG 2 NOT FOUND");
        }
      } catch (e) {
        console.error("Failed to read log 2:", e);
      }
    }
    expect(runningPid).toBeTypeOf("number");

    // Wait for the browser open attempt
    let opened = false;
    for (let i = 0; i < 250; i++) {
      if (existsSync(mockOpenLog)) {
        opened = true;
        break;
      }
      await sleep(100);
    }
    if (!opened) {
      try {
        console.error("LOG 2 CONTENT (opened=false):\n", readFileSync(join(tmpHome, "cli-start-2.log"), "utf-8"));
        const lifecycleLog = findLifecycleLog(tmpHome);
        if (lifecycleLog) {
          console.error("LIFECYCLE WORKER LOG 2 CONTENT:\n", readFileSync(lifecycleLog, "utf-8"));
        }
      } catch (e) {
        console.error("Failed to read log 2:", e);
      }
    }
    expect(opened).toBe(true);

    const logContent = readFileSync(mockOpenLog, "utf-8");
    expect(logContent).toContain(`http://localhost:${port}/sessions/daemon-int-orchestrator`);

    await execFileAsync(tsxBin, [cliEntry, "stop", "--all"], { cwd: repoPath, env, timeout: 20_000 });
  }, 60_000);

  it("ao stop terminates children spawned by ao start", async () => {
    const env = {
      ...process.env,
      HOME: tmpHome,
      AO_CALLER_TYPE: "agent",
      AO_CONFIG_PATH: configPath,
      AO_GLOBAL_CONFIG: configPath,
      PORT: String(port),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    };

    const logFd = openSync(join(tmpHome, "cli-start-3.log"), "w");
    const start = spawn(tsxBin, [cliEntry, "start", "--no-orchestrator", "--no-open-browser"], {
      cwd: repoPath,
      env,
      stdio: ["ignore", logFd, logFd],
    });
    startPid = start.pid;
    expect(startPid).toBeTypeOf("number");

    const runningPath = join(tmpHome, ".agent-orchestrator/running.json");
    let runningPid: number | undefined;
    for (let i = 0; i < 100; i++) {
      if (existsSync(runningPath)) {
        const running = JSON.parse(readFileSync(runningPath, "utf-8")) as { pid?: number };
        runningPid = running.pid;
        break;
      }
      await sleep(100);
    }
    if (runningPid === undefined) {
      try {
        console.error("LOG 3 CONTENT:\n", readFileSync(join(tmpHome, "cli-start-3.log"), "utf-8"));
        const lifecycleLog = findLifecycleLog(tmpHome);
        if (lifecycleLog) {
          console.error("LIFECYCLE WORKER LOG 3 CONTENT:\n", readFileSync(lifecycleLog, "utf-8"));
        } else {
          console.error("LIFECYCLE WORKER LOG 3 NOT FOUND");
        }
      } catch (e) {
        console.error("Failed to read log 3:", e);
      }
    }
    expect(runningPid).toBeTypeOf("number");

    const childPids = await readChildPids(runningPid!);
    expect(childPids.length).toBeGreaterThan(0);

    const lifecyclePidFile = findLifecyclePidFile(tmpHome);
    expect(lifecyclePidFile).not.toBeNull();
    const lifecyclePid = Number(readFileSync(lifecyclePidFile!, "utf-8").trim());
    expect(Number.isFinite(lifecyclePid)).toBe(true);
    expect(isAlive(lifecyclePid)).toBe(true);

    await execFileAsync(tsxBin, [cliEntry, "stop", "--all"], { cwd: repoPath, env, timeout: 20_000 });
    await sleep(5_000);

    const stillAlive = childPids.filter(isAlive);
    expect(stillAlive).toEqual([]);
    expect(isAlive(runningPid!)).toBe(false);
    expect(isAlive(lifecyclePid)).toBe(false);
  }, 60_000);
});
