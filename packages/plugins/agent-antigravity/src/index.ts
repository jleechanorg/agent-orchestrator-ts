import { createAgentPlugin, type AgentPluginConfig } from "@jleechanorg/ao-plugin-agent-base";
import {
  type Agent,
  type AgentLaunchConfig,
  type PluginModule,
  type ProjectConfig,
  type Session,
  type ActivityDetection,
} from "@jleechanorg/ao-core";
import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export const manifest = {
  name: "antigravity",
  slot: "agent" as const,
  description: "Agent plugin: Antigravity CLI (agy)",
  version: "0.1.0",
  displayName: "Antigravity (agy)",
};

const antigravityConfig: AgentPluginConfig = {
  name: "antigravity",
  description: manifest.description,
  processName: "agy",
  command: "agy",
  configDir: ".gemini", // Antigravity uses .gemini folder
  permissionlessFlag: "--dangerously-skip-permissions",
};

const antigravityOverrides: Partial<Agent> = {
  getLaunchCommand(launchConfig: AgentLaunchConfig): string {
    const parts = ["agy", "--prompt-interactive", '""'];
    const permissions = launchConfig.permissions ?? "permissionless";
    if (permissions === "permissionless" || permissions === "auto-edit" || permissions === "skip") {
      parts.push("--dangerously-skip-permissions");
    }
    return parts.join(" ");
  },

  getEnvironment(launchConfig: AgentLaunchConfig): Record<string, string> {
    const userHome = os.homedir();
    const sessionHome = path.join(userHome, ".ao-sessions", launchConfig.sessionId);
    
    // Ensure session directory exists
    fs.mkdirSync(sessionHome, { recursive: true });
    
    const srcGemini = path.join(userHome, ".gemini");
    const destGemini = path.join(sessionHome, ".gemini");
    
    const copyRecursiveSync = (src: string, dest: string) => {
      const exists = fs.existsSync(src);
      const isDirectory = exists && fs.statSync(src).isDirectory();
      if (isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach((childItemName: string) => {
          if (childItemName === "tmp" || childItemName === "history" || childItemName === "antigravity-browser-profile") {
            return;
          }
          copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
      } else {
        try {
          fs.copyFileSync(src, dest);
        } catch {
          // ignore
        }
      }
    };
    
    try {
      copyRecursiveSync(srcGemini, destGemini);
    } catch {
      // ignore
    }
    
    return {
      HOME: sessionHome,
      // Clear these to prevent the spawned CLI from inheriting parent agent context
      ANTIGRAVITY_PROJECT_ID: "",
      ANTIGRAVITY_TRAJECTORY_ID: "",
    };
  },

  async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
    return null;
  },

  async getActivityState(
    session: Session,
    _readyThresholdMs?: number,
  ): Promise<ActivityDetection | null> {
    // For Antigravity, we rely on process checking and terminal-output activity classification
    const exitedAt = new Date();
    if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
    const isProcessRunning = this.isProcessRunning;
    if (!isProcessRunning) return null;
    const running = await isProcessRunning(session.runtimeHandle);
    if (!running) return { state: "exited", timestamp: exitedAt };
    
    // We don't parse the binary .pb session files, so we return null to fall back
    // to terminal-output classification in the runner loop.
    return null;
  },
};

export function create(): Agent {
  return createAgentPlugin(antigravityConfig, antigravityOverrides);
}

export function detect(): boolean {
  try {
    // Verify agy is installed and accessible
    execFileSync("agy", ["help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
