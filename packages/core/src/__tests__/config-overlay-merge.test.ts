import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const originalHome = process.env["HOME"];
const originalCwd = process.cwd();
const originalStagingPath = process.env["AO_STAGING_CONFIG_PATH"];
const originalProdPath = process.env["AO_PROD_CONFIG_PATH"];
const originalConfigPath = process.env["AO_CONFIG_PATH"];
const tempDirs: string[] = [];

afterEach(() => {
  process.env["HOME"] = originalHome;
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
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MANAGED_CONFIG = `
defaults:
  runtime: tmux
  agent: claude-code
  agentConfig:
    model: claude-sonnet-4
projects:
  my-project:
    repo: org/repo
    path: ~/my-project
    agent: claude-code
    agentConfig:
      model: claude-sonnet-4
      permissions: default
`;

const REPO_LOCAL_CONFIG = `
defaults:
  agent: minimax
  agentConfig:
    model: MiniMax-M2.7
projects:
  my-project:
    agent: minimax
    agentConfig:
      model: MiniMax-M2.7
      permissions: skip
`;

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

describe("loadConfig with repo-local overlay", () => {
  it("merges repo-local project config on top of managed config", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-overlay-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-overlay-work-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "agent-orchestrator.yaml"),
      MANAGED_CONFIG,
      "utf-8",
    );
    writeFileSync(
      join(work, "agent-orchestrator.yaml"),
      REPO_LOCAL_CONFIG,
      "utf-8",
    );

    process.env["HOME"] = home;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    delete process.env["AO_PROD_CONFIG_PATH"];
    delete process.env["AO_CONFIG_PATH"];
    process.chdir(work);

    const config = loadConfig();

    expect(config.projects["my-project"].agent).toBe("minimax");
    expect(config.projects["my-project"].agentConfig?.model).toBe("MiniMax-M2.7");
    expect(config.projects["my-project"].agentConfig?.permissions).toBe("skip");
  });

  it("merges repo-local defaults on top of managed defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-defaults-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-defaults-work-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "agent-orchestrator.yaml"),
      MANAGED_CONFIG,
      "utf-8",
    );
    writeFileSync(
      join(work, "agent-orchestrator.yaml"),
      REPO_LOCAL_CONFIG,
      "utf-8",
    );

    process.env["HOME"] = home;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    delete process.env["AO_PROD_CONFIG_PATH"];
    delete process.env["AO_CONFIG_PATH"];
    process.chdir(work);

    const config = loadConfig();

    expect(config.defaults.agent).toBe("minimax");
    expect(config.defaults.agentConfig?.model).toBe("MiniMax-M2.7");
  });

  it("keeps managed config values when repo-local does not override them", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-keep-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-keep-work-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "agent-orchestrator.yaml"),
      MANAGED_CONFIG,
      "utf-8",
    );
    const repoLocalMinimal = `
projects:
  my-project:
    agent: minimax
`;
    writeFileSync(
      join(work, "agent-orchestrator.yaml"),
      repoLocalMinimal,
      "utf-8",
    );

    process.env["HOME"] = home;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    delete process.env["AO_PROD_CONFIG_PATH"];
    delete process.env["AO_CONFIG_PATH"];
    process.chdir(work);

    const config = loadConfig();

    expect(config.defaults.runtime).toBe("tmux");
    expect(config.projects["my-project"].agent).toBe("minimax");
  });

  it("adds repo-local project not present in managed config", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-add-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-add-work-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "agent-orchestrator.yaml"),
      MANAGED_CONFIG,
      "utf-8",
    );
    const repoLocalNewProject = `
projects:
  new-project:
    repo: org/new-repo
    path: ~/new-project
    agent: opencode
`;
    writeFileSync(
      join(work, "agent-orchestrator.yaml"),
      repoLocalNewProject,
      "utf-8",
    );

    process.env["HOME"] = home;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    delete process.env["AO_PROD_CONFIG_PATH"];
    delete process.env["AO_CONFIG_PATH"];
    process.chdir(work);

    const config = loadConfig();

    expect(config.projects["my-project"]).toBeDefined();
    expect(config.projects["new-project"]).toBeDefined();
    expect(config.projects["new-project"].agent).toBe("opencode");
  });

  it("does not overlay when primary is repo-local (no managed config)", () => {
    const work = mkdtempSync(join(tmpdir(), "ao-no-managed-"));
    tempDirs.push(work);

    writeFileSync(
      join(work, "agent-orchestrator.yaml"),
      MANAGED_CONFIG,
      "utf-8",
    );

    const home = mkdtempSync(join(tmpdir(), "ao-no-managed-home-"));
    tempDirs.push(home);

    process.env["HOME"] = home;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    delete process.env["AO_PROD_CONFIG_PATH"];
    delete process.env["AO_CONFIG_PATH"];
    process.chdir(work);

    const config = loadConfig();

    expect(config.projects["my-project"].agent).toBe("claude-code");
    expect(config.defaults.agent).toBe("claude-code");
  });
});
