import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentLaunchConfig } from "@jleechanorg/ao-core";
import { create } from "./index.js";

describe("antigravity .gemini materialization", () => {
  const originalHome = process.env.AO_ORIGINAL_HOME;
  let tempRoot: string | undefined;
  let tempRuntimeRoot: string | undefined;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.AO_ORIGINAL_HOME;
    } else {
      process.env.AO_ORIGINAL_HOME = originalHome;
    }
    if (tempRuntimeRoot) {
      rmSync(tempRuntimeRoot, { recursive: true, force: true });
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves canonical host children when a legacy session .gemini symlink points at them", () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "ao-antigravity-materialization-"));
    const userHome = path.join(tempRoot, "home");
    const hostGemini = path.join(userHome, ".gemini");
    const hostConfig = path.join(hostGemini, "config");
    const hostCli = path.join(hostGemini, "antigravity-cli");
    const projectPath = path.join(tempRoot, "project");
    const sessionId = `integration-${path.basename(tempRoot)}`;
    const sessionHome = path.join(userHome, ".ao-sessions", sessionId);
    const sessionGemini = path.join(sessionHome, ".gemini");
    tempRuntimeRoot = path.join(os.tmpdir(), `ao-${sessionId}`);

    mkdirSync(path.join(hostConfig, "projects"), { recursive: true });
    mkdirSync(hostCli, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(path.join(hostGemini, "installation_id"), "host-installation-id\n");
    writeFileSync(path.join(hostConfig, "projects", "sentinel.json"), '{"host":true}\n');
    writeFileSync(path.join(hostCli, "settings.json"), '{"theme":"host"}\n');
    mkdirSync(sessionHome, { recursive: true });
    symlinkSync(hostGemini, sessionGemini);
    process.env.AO_ORIGINAL_HOME = userHome;

    const launchConfig: AgentLaunchConfig = {
      sessionId,
      projectConfig: {
        name: "integration-project",
        repo: "owner/repo",
        path: projectPath,
        defaultBranch: "main",
        sessionPrefix: "integration",
      },
    };

    const env = create().getEnvironment(launchConfig);

    expect(env.HOME).toBe(sessionHome);
    expect(lstatSync(sessionGemini).isDirectory()).toBe(true);
    expect(lstatSync(sessionGemini).isSymbolicLink()).toBe(false);
    expect(lstatSync(path.join(hostGemini, "installation_id")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(hostGemini, "installation_id"), "utf8")).toBe(
      "host-installation-id\n",
    );
    expect(lstatSync(hostConfig).isDirectory()).toBe(true);
    expect(lstatSync(hostConfig).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(hostConfig, "projects", "sentinel.json"), "utf8")).toBe(
      '{"host":true}\n',
    );
    expect(readFileSync(path.join(hostCli, "settings.json"), "utf8")).toBe(
      '{"theme":"host"}\n',
    );
    expect(realpathSync(path.join(sessionGemini, "installation_id"))).toBe(
      realpathSync(path.join(hostGemini, "installation_id")),
    );
  });
});
