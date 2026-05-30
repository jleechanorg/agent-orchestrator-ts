import { createAgentPlugin, type AgentPluginConfig } from "@jleechanorg/ao-plugin-agent-base";
import {
  type Agent,
  type AgentLaunchConfig,
  type PluginModule,
  type ProjectConfig,
  type Session,
  type ActivityDetection,
  shellEscape,
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
    const promptArg = launchConfig.prompt ? shellEscape(launchConfig.prompt) : '""';
    const parts = ["agy", "--prompt-interactive", promptArg];
    const permissions = launchConfig.permissions ?? "permissionless";
    if (permissions === "permissionless" || permissions === "auto-edit" || permissions === "skip") {
      parts.push("--dangerously-skip-permissions");
    }
    return parts.join(" ");
  },

  getEnvironment(launchConfig: AgentLaunchConfig): Record<string, string> {
    const baseAgent = createAgentPlugin(antigravityConfig);
    const baseEnv = baseAgent.getEnvironment(launchConfig);

    const userHome = os.homedir();
    const sessionHome = path.join(userHome, ".ao-sessions", launchConfig.sessionId);
    
    // Ensure session directory exists
    fs.mkdirSync(sessionHome, { recursive: true });

    // Symlink the real keychain dir so Security framework can find/store tokens.
    // macOS Security looks at $HOME/Library/Keychains — without this, headless
    // agy workers show "A keychain cannot be found to store 'antigravity.'"
    const sessionKeychainDir = path.join(sessionHome, "Library", "Keychains");
    if (!fs.existsSync(sessionKeychainDir)) {
      fs.mkdirSync(path.join(sessionHome, "Library"), { recursive: true });
      fs.symlinkSync(path.join(userHome, "Library", "Keychains"), sessionKeychainDir);
    }

    const srcGemini = path.join(userHome, ".gemini");
    const destGemini = path.join(sessionHome, ".gemini");
    
    const copyRecursiveSync = (src: string, dest: string) => {
      const exists = fs.existsSync(src);
      const stats = exists ? fs.lstatSync(src) : null;
      if (stats?.isSymbolicLink()) return;
      const isDirectory = stats?.isDirectory() ?? false;
      if (isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach((childItemName: string) => {
          if (
            childItemName === "tmp" ||
            childItemName === "history" ||
            childItemName === "antigravity-browser-profile" ||
            childItemName === "conversations" || // runtime-only; not needed for new sessions
            childItemName === "brain" ||         // runtime-only; not needed for new sessions
            childItemName === "worktrees" ||     // never inherit prior worktrees
            childItemName === "playground" ||    // runtime workspace, 400MB+, starts fresh each session
            childItemName === "antigravity-ide" || // IDE integration data, 400MB+, not needed in CLI sessions
            childItemName === "brain.backup" ||  // backup, not needed per-session
            childItemName === "implicit.backup" || // backup, not needed per-session
            childItemName === "scratch" ||       // runtime scratch space, starts fresh each session
            childItemName === "log"              // runtime logs, not needed for new sessions
          ) {
            return;
          }
          copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
      } else {
        try {
          fs.copyFileSync(src, dest);
        } catch (err) {
          console.debug(`[antigravity] Failed to copy ${src}: ${(err as Error).message}`);
        }
      }
    };
    
    try {
      copyRecursiveSync(srcGemini, destGemini);
    } catch (err) {
      console.debug(`[antigravity] Failed to copy .gemini directory: ${(err as Error).message}`);
    }

    // Redirect conversations and brain to /tmp so they don't accumulate in the persistent
    // session dir. /tmp is cleaned on reboot; workers never need cross-session history.
    const agDir = path.join(destGemini, "antigravity");
    const tmpBase = path.join("/tmp", `ao-${launchConfig.sessionId}`);
    for (const sub of ["conversations", "brain"]) {
      const sessionSub = path.join(agDir, sub);
      const tmpSub = path.join(tmpBase, sub);
      if (!fs.existsSync(sessionSub)) {
        fs.mkdirSync(tmpSub, { recursive: true });
        fs.mkdirSync(agDir, { recursive: true });
        fs.symlinkSync(tmpSub, sessionSub);
      }
    }

    return {
      ...baseEnv,
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
