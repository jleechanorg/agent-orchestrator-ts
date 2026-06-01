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
import { execFileSync, spawn } from "node:child_process";
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
    // NOTE: Symlinking the user's real ~/Library/Keychains into headless background
    // worker sessions causes macOS Security framework to intercept the request and
    // constantly popup GUI Keychain Not Found / login credential authorization prompts.
    // To prevent this, we avoid symlinking the user's real system keychains.
    const sessionKeychainDir = path.join(sessionHome, "Library", "Keychains");
    try {
      const isTest = typeof process.env.VITEST !== "undefined" || process.env.NODE_ENV === "test";
      const isInteractive =
        process.env.AO_INTERACTIVE === "true" ||
        (!!(
          process.env.TERM_PROGRAM ||
          process.env.COLORTERM ||
          process.env.SSH_TTY
        ) && process.env.AO_HEADLESS !== "true");
      const isHeadless = (process.env.AO_HEADLESS === "true") || (!isTest && !isInteractive);

      let needsSetup = false;
      let isSymlink = false;
      try {
        const stat = fs.lstatSync(sessionKeychainDir);
        isSymlink = stat.isSymbolicLink();
      } catch {
        needsSetup = true;
      }

      if (!needsSetup) {
        if (isHeadless && os.platform() === "darwin") {
          // If it is a symlink but we are in headless mode, we need a real directory to store the temp keychain
          if (isSymlink) {
            try {
              fs.unlinkSync(sessionKeychainDir);
              needsSetup = true;
            } catch {
              // ignore
            }
          } else {
            // If it is a directory, check if our temp keychain database exists inside it
            const tempKeychainDbPath = path.join(sessionKeychainDir, "session.keychain-db");
            if (!fs.existsSync(tempKeychainDbPath)) {
              needsSetup = true;
            } else {
              // The keychain already exists! Just unlock it to be safe
              const tempKeychainPath = path.join(sessionKeychainDir, "session.keychain");
              const execOptions = {
                stdio: "ignore" as const,
                env: {
                  ...process.env,
                  HOME: sessionHome,
                },
              };
              try {
                execFileSync("security", ["unlock-keychain", "-p", "", tempKeychainPath], execOptions);
              } catch {
                // ignore
              }
            }
          }
        } else {
          // If we are in interactive mode, we always want it to be a symlink to the user's real keychains.
          // Recreate if it is not a symlink, or if it is a dangling symlink (target missing).
          if (!isSymlink || !fs.existsSync(sessionKeychainDir)) {
            try {
              if (isSymlink) {
                fs.unlinkSync(sessionKeychainDir);
              } else {
                fs.rmSync(sessionKeychainDir, { recursive: true, force: true });
              }
            } catch {
              // ignore
            }
            needsSetup = true;
          }
        }
      }

      if (needsSetup) {
        fs.mkdirSync(path.join(sessionHome, "Library"), { recursive: true });
        
        if (isHeadless && os.platform() === "darwin") {
          // In headless launchd/background contexts on macOS, the user's login keychain is locked
          // and inaccessible, causing macOS to display the "Keychain Not Found" GUI popup.
          // Fix: create and unlock a temporary, password-less session keychain so the
          // Security framework has a writable, unlocked keychain in this bootstrap namespace
          // without triggering any GUI prompts.
          const tempKeychainPath = path.join(sessionKeychainDir, "session.keychain");
          // Ensure Library/Preferences exists so the default-keychain plist can be written there
          fs.mkdirSync(path.join(sessionHome, "Library", "Preferences"), { recursive: true });
          const execOptions = {
            stdio: "ignore" as const,
            env: {
              ...process.env,
              HOME: sessionHome,
            },
          };
          
          try {
            // Get original default keychain so we can restore it safely
            let originalDefaultKeychain = "";
            try {
              const out = execFileSync("security", ["default-keychain"], { env: execOptions.env });
              if (out) {
                originalDefaultKeychain = out.toString().trim().replace(/^["']|["']$/g, "").trim();
              }
            } catch (err) {
              console.debug(`[antigravity] Failed to get original default keychain: ${(err as Error).message}`);
            }

            // Ensure the directory exists
            fs.mkdirSync(sessionKeychainDir, { recursive: true });

            // 1. Create the keychain
            execFileSync("security", ["create-keychain", "-p", "", tempKeychainPath], execOptions);
            
            // 2. Unlock the keychain
            execFileSync("security", ["unlock-keychain", "-p", "", tempKeychainPath], execOptions);
            
            // 3. Set it as the default keychain for this security session
            execFileSync("security", ["default-keychain", "-s", tempKeychainPath], execOptions);
            
            // 4. Set keychain settings to never lock
            execFileSync("security", ["set-keychain-settings", "-l", "-u", tempKeychainPath], execOptions);

            // 5. Restore the original default keychain after a short delay in a detached background process
            if (originalDefaultKeychain && originalDefaultKeychain !== tempKeychainPath) {
              const restorer = spawn(
                "sleep 10 && security default-keychain -s " + shellEscape(originalDefaultKeychain),
                {
                  shell: true,
                  detached: true,
                  stdio: "ignore",
                  env: { ...process.env },
                }
              );
              restorer.unref();
              console.debug(`[antigravity] Spawned background restorer to revert default keychain to ${originalDefaultKeychain} after 10s`);
            }
          } catch (keychainErr) {
            console.debug(`[antigravity] Failed to setup temp session keychain: ${(keychainErr as Error).message}`);
            // Fail closed in headless mode: do NOT fall back to real keychain symlink
            // to completely prevent any OS-level interactive prompts or deadlocks.
          }
        } else {
          // Interactive user GUI session: symlink the real keychain so the agent can read
          // and use the already-saved OAuth token from the real login keychain.
          try {
            if (fs.existsSync(sessionKeychainDir)) {
              fs.rmSync(sessionKeychainDir, { recursive: true, force: true });
            }
            fs.symlinkSync(path.join(userHome, "Library", "Keychains"), sessionKeychainDir);
          } catch (symlinkErr) {
            console.debug(`[antigravity] Failed to symlink login keychain: ${(symlinkErr as Error).message}`);
          }
        }
      }
    } catch (err) {
      console.debug(`[antigravity] Failed to setup keychains: ${(err as Error).message}`);
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
              needsSymlink = false;
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
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const settings = parsed as Record<string, unknown>;
          if (!settings["general"] || typeof settings["general"] !== "object" || Array.isArray(settings["general"])) {
            settings["general"] = {};
          }
          const general = settings["general"] as Record<string, unknown>;
          if (!general["sessionRetention"] || typeof general["sessionRetention"] !== "object" || Array.isArray(general["sessionRetention"])) {
            general["sessionRetention"] = {};
          }
          const sessionRetention = general["sessionRetention"] as Record<string, unknown>;
          sessionRetention["enabled"] = false;
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        }
      } catch (err) {
        console.debug(`[antigravity] Failed to update settings.json: ${(err as Error).message}`);
      }
    }

    // Automatically trust the project workspace path in the session config AND the global config
    // to completely prevent trust prompt deadlocks when HOME is reset in interactive shells.
    const trustedPaths = [
      path.join(destGemini, "trustedFolders.json"),
      path.join(userHome, ".gemini", "trustedFolders.json"),
    ];

    for (const trustedFoldersPath of trustedPaths) {
      // For the global trustedFolders, use a simple lock file to prevent concurrent races
      const isGlobal = trustedFoldersPath === path.join(userHome, ".gemini", "trustedFolders.json");
      const lockPath = isGlobal ? path.join(userHome, ".gemini", "trustedFolders.lock") : null;
      let releaseLock = () => {};
      let lockAcquired = false;

      if (lockPath) {
        try {
          fs.mkdirSync(path.dirname(lockPath), { recursive: true });
          try {
            fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
            lockAcquired = true;
            releaseLock = () => {
              try {
                fs.unlinkSync(lockPath);
              } catch {
                // ignore
              }
            };
          } catch (err: unknown) {
            const errWithCode = err as { code?: string };
            if (errWithCode.code === "EEXIST") {
              // Lock exists. Check if it's stale (older than 10s)
              try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > 10000) {
                  try {
                    fs.unlinkSync(lockPath);
                    // Try to acquire one more time
                    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
                    lockAcquired = true;
                    releaseLock = () => {
                      try {
                        fs.unlinkSync(lockPath);
                      } catch {
                        // ignore
                      }
                    };
                  } catch {
                    // ignore
                  }
                }
              } catch {
                // ignore
              }
            } else {
              throw err;
            }
          }
        } catch (lockErr) {
          console.debug(`[antigravity] Failed to acquire lock for trustedFolders: ${(lockErr as Error).message}`);
        }
      }

      try {
        let trustedFolders: Record<string, string> = {};
        let shouldWrite = true;

        if (lockPath && !lockAcquired) {
          console.debug(`[antigravity] Lock acquisition timed out for ${trustedFoldersPath}, skipping write to avoid clobbering.`);
          shouldWrite = false;
        }

        if (shouldWrite && fs.existsSync(trustedFoldersPath)) {
          try {
            const raw = fs.readFileSync(trustedFoldersPath, "utf-8").trim();
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                trustedFolders = parsed as Record<string, string>;
              }
            }
          } catch (e) {
            console.debug(`[antigravity] Failed to parse trustedFolders.json at ${trustedFoldersPath}, skipping write to avoid clobbering: ${(e as Error).message}`);
            shouldWrite = false;
          }
        }
        
        if (shouldWrite) {
          const pathsToTrust = [
            launchConfig.projectConfig.path,
            launchConfig.workspacePath,
          ].filter(Boolean) as string[];

          for (const p of pathsToTrust) {
            trustedFolders[p] = "TRUST_FOLDER";
            try {
              const resolvedPath = fs.realpathSync(p);
              trustedFolders[resolvedPath] = "TRUST_FOLDER";
            } catch {
              // ignore if realpath fails
            }
          }
          
          fs.mkdirSync(path.dirname(trustedFoldersPath), { recursive: true });
          fs.writeFileSync(trustedFoldersPath, JSON.stringify(trustedFolders, null, 2), "utf-8");
        }
      } catch (err) {
        console.debug(`[antigravity] Failed to update trustedFolders.json at ${trustedFoldersPath}: ${(err as Error).message}`);
      } finally {
        releaseLock();
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
