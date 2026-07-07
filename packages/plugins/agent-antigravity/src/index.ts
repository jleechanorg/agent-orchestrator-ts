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
import { expandHome } from "@jleechanorg/ao-core/paths";
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

// Top-level system directories that must NEVER be added to
// `trustedWorkspaces` — adding e.g. "/tmp" would trust every /tmp/<x>
// workspace on the host, "/var" would trust system-log locations, etc.
// The ancestor walk stops at or above these boundaries, never adds them,
// and never reaches the filesystem root ("/").
// 2026-06-14: Skeptic review flagged the over-trust risk for /tmp/<x> AO
// sessions; see PR #693 for the full rationale.
const TRUST_BOUNDARY_SYSTEM_ROOTS: readonly string[] = Object.freeze([
  "/tmp",
  "/var",
  "/opt",
  "/srv",
  "/etc",
]);

/**
 * Build the system-root stop set for the trust-workspace ancestor walk.
 * Includes the per-user homedir parent (e.g. "/Users" on macOS, "/home" on
 * Linux) plus the canonical shared system directories, so a worker launched
 * from `$HOME` or anywhere under it never gets to over-trust its way up
 * to the filesystem root.
 */
function buildSystemRootStopSet(userHome: string): ReadonlySet<string> {
  return new Set<string>([
    path.dirname(userHome),
    ...TRUST_BOUNDARY_SYSTEM_ROOTS,
  ]);
}

const antigravityConfig: AgentPluginConfig = {
  name: "antigravity",
  description: manifest.description,
  processName: "agy",
  command: "agy",
  configDir: ".gemini", // Antigravity uses .gemini folder
  permissionlessFlag: "--dangerously-skip-permissions",
};

function ensureIdempotentSymlink(target: string, linkPath: string, label: string): void {
  try {
    let isCorrectSymlink = false;
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        isCorrectSymlink = fs.readlinkSync(linkPath) === target;
        if (!isCorrectSymlink) {
          fs.unlinkSync(linkPath);
        }
      } else {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {
      // Path does not exist yet — nothing to clean up.
    }
    if (!isCorrectSymlink) {
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(target, linkPath);
    }
  } catch (err) {
    console.debug(`[antigravity] Failed to symlink ${label}: ${(err as Error).message}`);
  }
}


/** Top-level .gemini entries never materialized into the session (runtime / huge / never inherit). */
const GEMINI_SKIP_TOP_LEVEL = new Set([
  "tmp",
  "history",
  "antigravity-browser-profile",
  "worktrees",
  "playground",
  "antigravity-ide",
  "brain.backup",
  "implicit.backup",
  "scratch",
  "log",
]);

/** Subdirs under antigravity* app dirs redirected to /tmp after materialization. */
const GEMINI_APP_RUNTIME_SUBDIRS = new Set(["conversations", "brain"]);

/** App dirs that may contain per-session mutable settings.json — materialize as a tree. */
const GEMINI_APP_DIRS = new Set(["antigravity", "antigravity-cli", "antigravity-ide"]);

/** Files copied into the session because spawn logic mutates them per session. */
const GEMINI_SESSION_COPY_FILES = new Set(["settings.json", "trustedFolders.json"]);

function copyGeminiFileIfNeeded(src: string, dest: string): void {
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    console.debug(`[antigravity] Failed to copy ${src}: ${(err as Error).message}`);
  }
}

/**
 * Share host .gemini config via symlinks instead of duplicating ~85 MB per session.
 * Runtime dirs are skipped; mutable JSON files are copied; heavy static trees are symlinked.
 */
function materializeSharedGeminiConfig(userHome: string, sessionHome: string): void {
  const srcGemini = path.join(userHome, ".gemini");
  const destGemini = path.join(sessionHome, ".gemini");
  if (!fs.existsSync(srcGemini)) {
    return;
  }

  fs.mkdirSync(destGemini, { recursive: true });

  const materializeDir = (
    srcDir: string,
    destDir: string,
    skipNames: Set<string>,
    appTree: boolean,
  ): void => {
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
      if (skipNames.has(name)) {
        continue;
      }
      const src = path.join(srcDir, name);
      const dest = path.join(destDir, name);
      let stat;
      try {
        stat = fs.lstatSync(src);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        if (GEMINI_APP_DIRS.has(name) && !appTree) {
          materializeDir(src, dest, GEMINI_APP_RUNTIME_SUBDIRS, true);
        } else {
          ensureIdempotentSymlink(
            src,
            dest,
            path.join(".gemini", path.relative(srcGemini, dest)),
          );
        }
      } else if (GEMINI_SESSION_COPY_FILES.has(name) || (appTree && name === "settings.json")) {
        copyGeminiFileIfNeeded(src, dest);
      } else {
        ensureIdempotentSymlink(
          src,
          dest,
          path.join(".gemini", path.relative(srcGemini, dest)),
        );
      }
    }
  };

  materializeDir(srcGemini, destGemini, GEMINI_SKIP_TOP_LEVEL, false);
}

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

    // Prefer AO_ORIGINAL_HOME (captured once at orchestrator startup) over os.homedir().
// When this plugin runs inside a child orchestrator session whose own HOME was set to
// ~/.ao-sessions/<parent>, os.homedir() inherits that nested path and sessionHome ends up
// at ~/.ao-sessions/<parent>/.ao-sessions/<child> — the jc-* nesting bug. Pinning to
// the real user home via AO_ORIGINAL_HOME keeps the path flat regardless of depth.
    const userHome = process.env.AO_ORIGINAL_HOME ?? os.homedir();
    const sessionHome = path.join(userHome, ".ao-sessions", launchConfig.sessionId);

    // Ensure session directory exists
    fs.mkdirSync(sessionHome, { recursive: true });

    // Point the session HOME's Library/Keychains at the user's REAL keychains so the macOS
    // Security framework can find the already-stored Antigravity OAuth token and git
    // credentials. The worker runs under $HOME=~/.ao-sessions/<id>, where
    // $HOME/Library/Keychains does not exist; any keychain read/write from that context
    // raises the GUI "A keychain cannot be found to store '<name>'" SecurityAgent modal on
    // the user's screen (names seen: "antigravity", "x-access-token", "jleechan2015").
    //
    // We do NOT try to detect "headless vs interactive" from terminal env vars
    // (TERM_PROGRAM/COLORTERM/SSH_TTY): AO workers run inside tmux, which sets those vars,
    // so that heuristic misclassified every background worker as interactive and the
    // keychain-bypass path never ran. Guessing execution context from the environment is
    // unreliable — we always symlink to the real keychains, which already contain the
    // needed entries, so reads succeed silently and no modal is shown.
    if (os.platform() === "darwin") {
      const sessionKeychainDir = path.join(sessionHome, "Library", "Keychains");
      const realKeychainDir = path.join(userHome, "Library", "Keychains");
      ensureIdempotentSymlink(realKeychainDir, sessionKeychainDir, "login keychain");
    }

    // Share the user's Playwright browser cache (ms-playwright-go for MCP agents,
    // ms-playwright for Python) across all antigravity sessions instead of letting
    // each session duplicate its own ~124 MB copy under $HOME/Library/Caches. Across
    // 24 wa-* sessions that would otherwise consume ~3 GB on disk. Mirrors the
    // Keychains block above: lstat-then-symlink, idempotent. We only symlink when
    // the target exists on the host so users without Playwright don't get dangling
    // links. Both directories are tried; only the ones that actually exist get linked.
    const playwrightCacheDirs = [
      path.join("Library", "Caches", "ms-playwright-go"),
      path.join("Library", "Caches", "ms-playwright"),
    ];
    for (const relCacheDir of playwrightCacheDirs) {
      const sessionCacheDir = path.join(sessionHome, relCacheDir);
      const realCacheDir = path.join(userHome, relCacheDir);
      if (fs.existsSync(realCacheDir)) {
        ensureIdempotentSymlink(realCacheDir, sessionCacheDir, relCacheDir);
      }
    }

    const destGemini = path.join(sessionHome, ".gemini");

    try {
      materializeSharedGeminiConfig(userHome, sessionHome);
    } catch (err) {
      console.debug(`[antigravity] Failed to materialize shared .gemini config: ${(err as Error).message}`);
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
                if (fs.existsSync(lockPath)) {
                  const content = fs.readFileSync(lockPath, "utf-8").trim();
                  if (content === String(process.pid)) {
                    fs.unlinkSync(lockPath);
                  }
                }
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
                        if (fs.existsSync(lockPath)) {
                          const content = fs.readFileSync(lockPath, "utf-8").trim();
                          if (content === String(process.pid)) {
                            fs.unlinkSync(lockPath);
                          }
                        }
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
            "/tmp",
            "/private/tmp",
            os.tmpdir(),
          ].filter(Boolean) as string[];

          for (let p of pathsToTrust) {
            // Canonical helper expands ~/...; bare ~ is the homedir itself.
            p = p === "~" ? userHome : expandHome(p);
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

    // Resolve COLIMA_HOME once and reuse it for both COLIMA_HOME and the
    // darwin DOCKER_HOST default. If a user overrides COLIMA_HOME to a
    // non-default location (e.g. /opt/my-colima), the DOCKER_HOST default
    // must follow the same path so colima and docker agree on where the
    // socket lives — otherwise the worker would point docker at the user's
    // real-home socket while colima is actually serving from /opt.
    //
    // Override behavior: read process.env first so a user-supplied value
    // survives. This is necessary because the runtime layer applies
    // config.environment ON TOP of process.env at spawn time
    // (`{ ...process.env, ...config.environment }` in runtime-process;
    // `tmux -e KEY=VALUE` per-key in runtime-tmux), so a value the plugin
    // returns here would otherwise overwrite whatever the user set in
    // their shell. `baseEnv.COLIMA_HOME` is also respected for callers that
    // inject via the base agent.
    const colimaHome =
      process.env.COLIMA_HOME
      ?? baseEnv.COLIMA_HOME
      ?? path.join(userHome, ".colima");

    // Build the env object explicitly. DOCKER_HOST is conditionally included
    // because Object.entries(env) on a key with `undefined` value still yields
    // the key, and the runtime layer (tmux `-e KEY=VALUE`, child-process `env`)
    // stringifies the value as the literal "undefined" — which would break
    // native Docker on Linux where DOCKER_HOST must be UNSET (not
    // `DOCKER_HOST=undefined`). We also `delete` any pre-existing DOCKER_HOST
    // key from baseEnv first so a future change to the base agent that
    // includes `DOCKER_HOST: undefined` in baseEnv cannot leak through the
    // spread. See PR #686 Skeptic Gate-7/8 follow-up.
    const env: Record<string, string> = {
      ...baseEnv,
      HOME: sessionHome,
      // Pin COLIMA_HOME to the resolved path so any subprocess in the worker
      // that calls `colima start` or `docker compose up` reuses the host's
      // main colima VM (or its socket) instead of deriving COLIMA_HOME from
      // the overridden session HOME and bootstrapping a fresh per-worker VM
      // at ~/.ao-sessions/<id>/.colima/ (~2GB each, accumulating to dozens of
      // stale VMs across runs). See PR for the wa-2327 incident.
      COLIMA_HOME: colimaHome,
      // Clear these to prevent the spawned CLI from inheriting parent agent context
      ANTIGRAVITY_PROJECT_ID: "",
      ANTIGRAVITY_TRAJECTORY_ID: "",
      // Belt-and-suspenders: gemini-cli (which `agy` forks from) reads
      // GEMINI_CLI_TRUST_WORKSPACE=true at startup and skips the trust
      // prompt for the session, regardless of folderTrust settings. Set
      // this unconditionally in workers so a stale or accidentally-stricter
      // settings.json can never re-introduce the trust-prompt deadlock.
      // 2026-06-14: wa-2282/2351/2352 each blocked ~6-10 minutes on this
      // prompt before any tool call. See:
      //   https://geminicli.com/docs/cli/trusted-folders ("Headless and
      //   Automated Environments" — "Bypass options: ... Environment
      //   variable: GEMINI_CLI_TRUST_WORKSPACE=true").
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    };
    // DOCKER_HOST: only set on darwin (colima default) or if the user
    // explicitly overrode it. On Linux without an override, leave the key
    // ABSENT (not undefined) so the runtime omits it and the worker's
    // `docker` calls fall back to native /var/run/docker.sock.
    //
    // We use `"DOCKER_HOST" in process.env` (not truthiness) so a user who
    // explicitly sets DOCKER_HOST="" to signal "unset" gets exactly that —
    // not a silent fallback to the colima default. Empty-string is a
    // meaningful override; truthiness (`if (process.env.DOCKER_HOST)`)
    // would clobber it. The same applies to `baseEnv`. PR #686 Skeptic
    // Gate-5/7 follow-up.
    //
    // We `delete` first to defend against baseEnv pre-pollution — even if
    // baseAgent.getEnvironment() later adds DOCKER_HOST to its return, this
    // explicit delete (combined with the conditional re-add below) keeps
    // the key absent on Linux.
    //
    // KNOWN LIMITATION: the darwin DOCKER_HOST default below hardcodes the
    // "default" colima profile directory. A user running a non-default
    // profile (e.g. `~/.colima/myprofile/`) will get a DOCKER_HOST that
    // doesn't match their actual socket path; they must also set
    // DOCKER_HOST explicitly. Colima's stock install uses the "default"
    // profile, so this covers the common case.
    delete env.DOCKER_HOST;
    if ("DOCKER_HOST" in process.env) {
      env.DOCKER_HOST = process.env.DOCKER_HOST as string;
    } else if ("DOCKER_HOST" in baseEnv) {
      env.DOCKER_HOST = baseEnv.DOCKER_HOST as string;
    } else if (os.platform() === "darwin") {
      env.DOCKER_HOST = `unix://${path.join(colimaHome, "default", "docker.sock")}`;
    }

    // ALSO pre-seed the inner antigravity-cli/settings.json `trustedWorkspaces`
    // array. The outer `trustedFolders.json` (written above) is NOT the file agy
    // checks at session start — agy reads `trustedWorkspaces` from
    // `antigravity-cli/settings.json`. Without this, fresh worktree paths
    // (which agy treats as "hidden" because they live under `.worktrees/`)
    // trigger the "Do you trust this project?" TUI prompt and AO's
    // stuck-worker-detector kills the session within 60-90s of spawn.
    // (Repro: ao-6353 killed at 98s with killConfirmed=stuck-probe; the inner
    // trustedWorkspaces did not contain /Users/jleechan/.worktrees/.../ao-6353.)
    try {
      const agyCliSettingsPath = path.join(
        destGemini,
        "antigravity-cli",
        "settings.json",
      );
      const innerPathsToTrust = [
        launchConfig.projectConfig.path,
        launchConfig.workspacePath,
      ].filter(Boolean) as string[];

      let shouldWriteInner = true;
      let innerSettings: Record<string, unknown> = {};
      if (fs.existsSync(agyCliSettingsPath)) {
        try {
          const raw = fs.readFileSync(agyCliSettingsPath, "utf-8").trim();
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              innerSettings = parsed as Record<string, unknown>;
            }
          }
        } catch (e) {
          // Fail-closed: if the existing settings file cannot be parsed (JSONC,
          // trailing-comma content, partial write from a prior crashed session,
          // etc.), do NOT overwrite it. The existing trustedFolders pre-seed
          // already fails closed on parse errors for the same reason — clobbering
          // the inner settings with just `trustedWorkspaces` would drop other
          // settings the spawned `agy` session depends on.
          console.debug(
            `[antigravity] Failed to parse antigravity-cli/settings.json at ${agyCliSettingsPath}, skipping write to avoid clobbering: ${(e as Error).message}`,
          );
          shouldWriteInner = false;
        }
      }

      if (shouldWriteInner) {
        const existingTrusted = Array.isArray(innerSettings.trustedWorkspaces)
          ? (innerSettings.trustedWorkspaces as unknown[]).filter(
              (p): p is string => typeof p === "string",
            )
          : [];
        const trustedSet = new Set<string>(existingTrusted);

        // Build a deduplicated list of every path that should be trusted: the
        // explicit project + workspace paths AND every ancestor of each one.
        // agy / gemini-cli checks `trustedWorkspaces` using longest-prefix
        // match — it does NOT walk up the directory tree, so a path like
        // `/Users/jleechan/.worktrees/worldarchitect/wa-1702` must be added
        // explicitly; pre-seeding only the project root leaves worktrees
        // un-trusted and re-introduces the TUI prompt. Adding every ancestor
        // gives us belt-and-suspenders coverage for nested worktrees,
        // /tmp/<x>/y sessions, and any future layout that nests a worker
        // cwd under a path the AO operator did not anticipate. We dedupe via
        // a Set so a path that is its own ancestor is not added twice.
        // 2026-06-14: trust-prompt recurrence across wa-2282/wa-2351/wa-2352
        // showed that pre-seeding only the project root was insufficient —
        // the worker's tmux cwd was a deeper nested path inside the worktree.
        const allSeedPaths = new Set<string>();
        const addWithAncestors = (raw: string) => {
          const canonical = raw === "~" ? userHome : expandHome(raw);
          if (!canonical) return;
          let cur = canonical;
          // Walk up to (but not including) the home directory. We deliberately
          // stop ONE level above the home dir so we never add the homedir
          // itself to trustedWorkspaces — that would silently over-trust
          // the user's entire home, including any unrelated cloned repo
          // under ~/projects/ or similar. The path-prefix check is
          // inclusive: trusting "/Users/jleechan" would match every
          // workspace the user has, which violates the principle of least
          // privilege. Stop at the parent of the homedir (i.e. "/Users" on
          // macOS) instead.
          //
          // Special case: if the canonical path IS the homedir itself
          // (extremely unusual — only happens for a project whose path is
          // literally $HOME), don't add it.
          if (canonical === userHome) return;
          const stopAt = userHome;
          // Top-level system directories are off-limits as trust roots (see
          // TRUST_BOUNDARY_SYSTEM_ROOTS at module top). The ancestor walk
          // stops at or above these boundaries, never adds them, and never
          // reaches the filesystem root ("/").
          // 2026-06-14: Skeptic review flagged the over-trust risk for
          // /tmp/<x> AO sessions; cap the walk at the immediate parent of
          // any "shared" system root.
          const systemRootSet = buildSystemRootStopSet(userHome);
          while (cur && cur !== stopAt && cur !== path.dirname(cur)) {
            if (systemRootSet.has(cur)) break; // never trust a shared system root
            allSeedPaths.add(cur);
            try {
              const resolved = fs.realpathSync(cur);
              if (resolved && resolved !== cur) allSeedPaths.add(resolved);
            } catch {
              // realpath may fail for non-existent or permission-denied paths; ignore.
            }
            const parent = path.dirname(cur);
            if (parent === cur) break; // reached filesystem root
            cur = parent;
          }
        };
        for (const p of innerPathsToTrust) {
          addWithAncestors(p);
        }

        for (const p of allSeedPaths) {
          trustedSet.add(p);
        }

        innerSettings.trustedWorkspaces = Array.from(trustedSet);

        // ALSO inject the global trust-bypass flags so that even if
        // `trustedWorkspaces` is missing some future path the worker lands in,
        // agy / gemini-cli will not pop the TUI prompt. The flags are the
        // canonical escape hatches documented in
        // https://geminicli.com/docs/cli/trusted-folders (gemini-cli upstream;
        // agy is a downstream fork that honors the same keys).
        //
        // Both keys are written idempotently: if either is already set to
        // `true`, the write flips it to `false` to honor the AO operator's
        // intent of "never prompt in workers".
        const ensureFlagFalse = (
          root: Record<string, unknown>,
          dottedPath: readonly string[],
        ) => {
          let cur: Record<string, unknown> = root;
          for (let i = 0; i < dottedPath.length - 1; i++) {
            const seg = dottedPath[i];
            const next = cur[seg];
            if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
              cur[seg] = {};
            }
            cur = cur[seg] as Record<string, unknown>;
          }
          const last = dottedPath[dottedPath.length - 1];
          cur[last] = false;
        };
        ensureFlagFalse(innerSettings, ["security", "folderTrust", "enabled"]);
        // NOTE: do NOT also write a top-level `"security.folderTrust.enabled"`
        // (literal dots) key as a belt-and-suspenders fallback. Gemini's settings
        // schema (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json)
        // represents `security.folderTrust.enabled` as a nested property and
        // rejects unknown top-level keys; writing the dotted form alongside the
        // nested form would fail strict settings validation and surface as a
        // "bad manual settings" warning at agy startup, blocking the trust
        // bypass from taking effect (CodeRabbit P2 review of PR #693).
        //
        // Also drop any pre-existing top-level dotted key in the user file —
        // if a previous version of this pre-seed wrote one, it would survive
        // the read-modify-write cycle above and continue to fail strict
        // settings validation in newer agy builds. We delete it explicitly.
        delete innerSettings["security.folderTrust.enabled"];

        fs.mkdirSync(path.dirname(agyCliSettingsPath), { recursive: true });
        fs.writeFileSync(
          agyCliSettingsPath,
          JSON.stringify(innerSettings, null, 2),
          "utf-8",
        );
      }
    } catch (err) {
      console.debug(
        `[antigravity] Failed to pre-seed antigravity-cli/settings.json trustedWorkspaces: ${(err as Error).message}`,
      );
    }

    return env;
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
