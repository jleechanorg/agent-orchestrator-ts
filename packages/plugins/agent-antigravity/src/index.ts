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
    try {
      if (!fs.existsSync(sessionKeychainDir)) {
        fs.mkdirSync(path.join(sessionHome, "Library"), { recursive: true });
        fs.symlinkSync(path.join(userHome, "Library", "Keychains"), sessionKeychainDir);
      }
    } catch (err) {
      console.debug(`[antigravity] Failed to symlink keychains: ${(err as Error).message}`);
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

    // Redirect conversations and brain to /tmp so they don't persist in the session dir.
    // /tmp is cleaned on reboot; sessions never need cross-session conversation history.
    const tmpBase = path.join(os.tmpdir(), `ao-${launchConfig.sessionId}`);
    for (const appDirName of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
      const agDir = path.join(destGemini, appDirName);
      for (const sub of ["conversations", "brain"]) {
        const sessionSub = path.join(agDir, sub);
        const tmpSub = path.join(tmpBase, appDirName, sub);
        
        let needsSymlink = true;
        try {
          const stat = fs.lstatSync(sessionSub);
          if (stat.isSymbolicLink()) {
            try {
              fs.unlinkSync(sessionSub);
            } catch (err) {
              console.debug(`[antigravity] Failed to unlink dangling symlink ${sessionSub}: ${(err as Error).message}`);
            }
          } else {
            // Already a real directory/file, do not overwrite/symlink
            needsSymlink = false;
          }
        } catch {
          // Entry doesn't exist, we can proceed
        }

        if (needsSymlink) {
          try {
            fs.mkdirSync(tmpSub, { recursive: true });
            fs.mkdirSync(path.dirname(sessionSub), { recursive: true });
            fs.symlinkSync(tmpSub, sessionSub);
          } catch (err) {
            console.debug(`[antigravity] Failed to symlink ${sessionSub} to ${tmpSub}: ${(err as Error).message}`);
          }
        }
      }
    }

    // Disable session retention inside settings.json for the session to prevent extra bloat
    const settingsPath = path.join(destGemini, "settings.json");
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (!settings.general) {
          settings.general = {};
        }
        if (!settings.general.sessionRetention) {
          settings.general.sessionRetention = {};
        }
        settings.general.sessionRetention.enabled = false;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
      } catch (err) {
        console.debug(`[antigravity] Failed to update settings.json: ${(err as Error).message}`);
      }
    }

    // Automatically trust the project workspace path in the session config to prevent trust prompt deadlocks
    const trustedFoldersPath = path.join(destGemini, "trustedFolders.json");
    try {
      let trustedFolders: Record<string, string> = {};
      if (fs.existsSync(trustedFoldersPath)) {
        try {
          trustedFolders = JSON.parse(fs.readFileSync(trustedFoldersPath, "utf-8"));
        } catch {
          // ignore parsing error, start fresh
        }
      }
      
      const projectPath = launchConfig.projectConfig.path;
      if (projectPath) {
        trustedFolders[projectPath] = "TRUST_FOLDER";
        try {
          const resolvedPath = fs.realpathSync(projectPath);
          trustedFolders[resolvedPath] = "TRUST_FOLDER";
        } catch {
          // ignore if realpath fails
        }
      }
      
      fs.mkdirSync(path.dirname(trustedFoldersPath), { recursive: true });
      fs.writeFileSync(trustedFoldersPath, JSON.stringify(trustedFolders, null, 2), "utf-8");
    } catch (err) {
      console.debug(`[antigravity] Failed to update trustedFolders.json: ${(err as Error).message}`);
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
