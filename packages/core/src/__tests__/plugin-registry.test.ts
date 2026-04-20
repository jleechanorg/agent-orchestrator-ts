import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_PLUGINS,
  createPluginRegistry,
  isPackageResolutionFailure,
} from "../plugin-registry.js";
import type { PluginModule, PluginManifest, OrchestratorConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlugin(slot: PluginManifest["slot"], name: string): PluginModule {
  return {
    manifest: {
      name,
      slot,
      description: `Test ${slot} plugin: ${name}`,
      version: "0.0.1",
    },
    create: vi.fn((config?: Record<string, unknown>) => ({
      name,
      _config: config,
    })),
  };
}

function makeOrchestratorConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    projects: {},
    ...overrides,
  } as OrchestratorConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isPackageResolutionFailure", () => {
  it("returns true for ERR_MODULE_NOT_FOUND with package id in message", () => {
    const err = new Error("Cannot find package '@jleechanorg/ao-plugin-agent-gemini'");
    (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
    expect(isPackageResolutionFailure(err, "@jleechanorg/ao-plugin-agent-gemini")).toBe(true);
  });

  it("returns false for init/runtime errors without resolution shape", () => {
    expect(
      isPackageResolutionFailure(new Error("initialize() failed"), "@jleechanorg/ao-plugin-agent-gemini"),
    ).toBe(false);
  });

  it("returns false when ERR_MODULE_NOT_FOUND message names a different package than pkg", () => {
    const err = new Error("Cannot find package '@jleechanorg/ao-plugin-agent-codex'");
    (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
    expect(isPackageResolutionFailure(err, "@jleechanorg/ao-plugin-agent-gemini")).toBe(false);
  });
});

describe("createPluginRegistry", () => {
  it("returns a registry object", () => {
    const registry = createPluginRegistry();
    expect(registry).toHaveProperty("register");
    expect(registry).toHaveProperty("get");
    expect(registry).toHaveProperty("list");
    expect(registry).toHaveProperty("loadBuiltins");
    expect(registry).toHaveProperty("loadFromConfig");
  });
});

describe("register + get", () => {
  it("registers and retrieves a plugin", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("runtime", "tmux");

    registry.register(plugin);

    const instance = registry.get<{ name: string }>("runtime", "tmux");
    expect(instance).not.toBeNull();
    expect(instance!.name).toBe("tmux");
  });

  it("returns null for unregistered plugin", () => {
    const registry = createPluginRegistry();
    expect(registry.get("runtime", "nonexistent")).toBeNull();
  });

  it("passes config to plugin create()", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("workspace", "worktree");

    registry.register(plugin, { worktreeDir: "/custom/path" });

    expect(plugin.create).toHaveBeenCalledWith({ worktreeDir: "/custom/path" });
    const instance = registry.get<{ _config: Record<string, unknown> }>("workspace", "worktree");
    expect(instance!._config).toEqual({ worktreeDir: "/custom/path" });
  });

  it("overwrites previously registered plugin with same slot:name", () => {
    const registry = createPluginRegistry();
    const plugin1 = makePlugin("runtime", "tmux");
    const plugin2 = makePlugin("runtime", "tmux");

    registry.register(plugin1);
    registry.register(plugin2);

    // Should call create on both
    expect(plugin1.create).toHaveBeenCalledTimes(1);
    expect(plugin2.create).toHaveBeenCalledTimes(1);

    // get() returns the latest
    const instance = registry.get<{ name: string }>("runtime", "tmux");
    expect(instance).not.toBeNull();
  });

  it("registers plugins in different slots independently", () => {
    const registry = createPluginRegistry();
    const runtimePlugin = makePlugin("runtime", "tmux");
    const workspacePlugin = makePlugin("workspace", "worktree");

    registry.register(runtimePlugin);
    registry.register(workspacePlugin);

    expect(registry.get("runtime", "tmux")).not.toBeNull();
    expect(registry.get("workspace", "worktree")).not.toBeNull();
    expect(registry.get("runtime", "worktree")).toBeNull();
    expect(registry.get("workspace", "tmux")).toBeNull();
  });
});

describe("list", () => {
  it("lists plugins in a given slot", () => {
    const registry = createPluginRegistry();
    registry.register(makePlugin("runtime", "tmux"));
    registry.register(makePlugin("runtime", "process"));
    registry.register(makePlugin("workspace", "worktree"));

    const runtimes = registry.list("runtime");
    expect(runtimes).toHaveLength(2);
    expect(runtimes.map((m) => m.name)).toContain("tmux");
    expect(runtimes.map((m) => m.name)).toContain("process");
  });

  it("returns empty array for slot with no plugins", () => {
    const registry = createPluginRegistry();
    expect(registry.list("notifier")).toEqual([]);
  });

  it("does not return plugins from other slots", () => {
    const registry = createPluginRegistry();
    registry.register(makePlugin("runtime", "tmux"));

    expect(registry.list("workspace")).toEqual([]);
  });
});

describe("loadBuiltins", () => {
  it("warns when a builtin plugin import fails (no silent swallow)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockReturnValue();
    const registry = createPluginRegistry();
    // Simulate npm failing to resolve the package (outside monorepo case).
    // Disable real monorepo fallback so we assert on [plugin-registry] warn, not
    // successful disk loads or unrelated notifier warnings.
    await registry.loadBuiltins(
      undefined,
      async () => {
        throw new Error("ERR_MODULE_NOT_FOUND: cannot find package '@jleechanorg/ao-plugin-runtime-tmux'");
      },
      async () => null,
    );
    // Must log a warning, not silently swallow
    expect(warnSpy).toHaveBeenCalled();
    const registryWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes("[plugin-registry]"),
    );
    expect(registryWarn?.[0]).toContain("@jleechanorg/ao-plugin-runtime-tmux");
    warnSpy.mockRestore();
  });

  it("warns on ERR_MODULE_NOT_FOUND from outside the monorepo", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockReturnValue();
    const registry = createPluginRegistry();
    await registry.loadBuiltins(
      undefined,
      async () => {
        const err = new Error("cannot find module '@jleechanorg/ao-plugin-agent-gemini'");
        (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
        throw err;
      },
      async () => null,
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("falls back to __dirname-relative resolution when normal import fails", async () => {
    // This test simulates running `ao` from outside the monorepo where npm cannot
    // resolve workspace-linked packages. The registry should try monorepo-relative
    // resolution from plugin-registry's location.
    const warnSpy = vi.spyOn(console, "warn").mockReturnValue();
    const registry = createPluginRegistry();
    const fakeGemini = makePlugin("agent", "gemini");

    // Primary importFn: always fails (npm cannot resolve workspace packages outside monorepo)
    // fallbackImportFn: returns the fake gemini (monorepo fallback succeeded)
    await registry.loadBuiltins(
      undefined,
      async () => {
        const err = new Error("ERR_MODULE_NOT_FOUND: cannot find package '@jleechanorg/ao-plugin-agent-gemini'");
        (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
        throw err;
      },
      async (pkg: string) => {
        // Fallback: simulate the monorepo-relative path resolution succeeding
        if (pkg.includes("agent-gemini")) return fakeGemini;
        return null; // other plugins have no fallback
      },
    );

    // Gemini should be registered via the fallback path (not npm)
    expect(registry.get("agent", "gemini")).not.toBeNull();
    warnSpy.mockRestore();
  });

  it("resolves --agent gemini via fallback when outside the monorepo", async () => {
    // Integration test: when the gemini plugin cannot be resolved via npm
    // (ERR_MODULE_NOT_FOUND), the fallback path should still register it.
    const warnSpy = vi.spyOn(console, "warn").mockReturnValue();
    const registry = createPluginRegistry();
    const fakeGemini = makePlugin("agent", "gemini");

    await registry.loadBuiltins(
      undefined,
      async () => {
        const err = new Error("ERR_MODULE_NOT_FOUND: cannot find package '@jleechanorg/ao-plugin-agent-gemini'");
        (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
        throw err;
      },
      async (pkg: string) => {
        if (pkg.includes("agent-gemini")) return fakeGemini;
        return null;
      },
    );

    // The gemini agent plugin should be registered (fallback succeeded)
    expect(registry.get("agent", "gemini")).not.toBeNull();
    expect(registry.list("agent")).toContainEqual(
      expect.objectContaining({ name: "gemini", slot: "agent" }),
    );
    warnSpy.mockRestore();
  });

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const geminiBuiltEntry = join(repoRoot, "packages/plugins/agent-gemini/dist/index.js");

  it.skipIf(!existsSync(geminiBuiltEntry))(
    "loads the real gemini builtin via default monorepo fallback when npm resolution fails",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockReturnValue();
      const registry = createPluginRegistry();
      const geminiPkg = "@jleechanorg/ao-plugin-agent-gemini";

      await registry.loadBuiltins(undefined, async (pkg) => {
        if (pkg === geminiPkg) {
          const e = new Error(`Cannot find package '${geminiPkg}'`);
          (e as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
          throw e;
        }
        const spec = BUILTIN_PLUGINS.find((b) => b.pkg === pkg);
        if (!spec) throw new Error(`unexpected builtin package: ${pkg}`);
        return makePlugin(spec.slot, spec.name);
      });

      expect(registry.get("agent", "gemini")).not.toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    },
    45_000,
  );

  it("does not invoke fallbackImportFn when primary import fails for non-resolution reasons", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fallbackSpy = vi.fn(async () => makePlugin("agent", "gemini"));
    const registry = createPluginRegistry();
    const geminiPkg = "@jleechanorg/ao-plugin-agent-gemini";

    await registry.loadBuiltins(
      undefined,
      async (pkg) => {
        if (pkg === geminiPkg) {
          throw new Error("plugin initialize() failed");
        }
        const spec = BUILTIN_PLUGINS.find((b) => b.pkg === pkg);
        if (!spec) throw new Error(`unexpected builtin package: ${pkg}`);
        return makePlugin(spec.slot, spec.name);
      },
      fallbackSpy,
    );

    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("plugin initialize() failed"),
    );
    warnSpy.mockRestore();
  });

  it("registers multiple agent plugins from importFn", async () => {
    const registry = createPluginRegistry();

    const fakeClaudeCode = makePlugin("agent", "claude-code");
    const fakeCodex = makePlugin("agent", "codex");
    const fakeOpenCode = makePlugin("agent", "opencode");
    const fakeGemini = makePlugin("agent", "gemini");
    const fakeMinimax = makePlugin("agent", "minimax");

    await registry.loadBuiltins(
      undefined,
      async (pkg: string) => {
        if (pkg === "@jleechanorg/ao-plugin-agent-claude-code") return fakeClaudeCode;
        if (pkg === "@jleechanorg/ao-plugin-agent-codex") return fakeCodex;
        if (pkg === "@jleechanorg/ao-plugin-agent-opencode") return fakeOpenCode;
        if (pkg === "@jleechanorg/ao-plugin-agent-gemini") return fakeGemini;
        if (pkg === "@jleechanorg/ao-plugin-agent-minimax") return fakeMinimax;
        throw new Error(`Not found: ${pkg}`);
      },
      async () => null,
    );

    const agents = registry.list("agent");
    expect(agents).toContainEqual(expect.objectContaining({ name: "claude-code", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "codex", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "opencode", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "gemini", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "minimax", slot: "agent" }));

    expect(registry.get("agent", "codex")).not.toBeNull();
    expect(registry.get("agent", "claude-code")).not.toBeNull();
    expect(registry.get("agent", "opencode")).not.toBeNull();
    expect(registry.get("agent", "gemini")).not.toBeNull();
    expect(registry.get("agent", "minimax")).not.toBeNull();
  });

  it("registers gitlab tracker and scm plugins from importFn", async () => {
    const registry = createPluginRegistry();

    const fakeTracker = makePlugin("tracker", "gitlab");
    const fakeScm = makePlugin("scm", "gitlab");

    await registry.loadBuiltins(
      undefined,
      async (pkg: string) => {
        if (pkg === "@jleechanorg/ao-plugin-tracker-gitlab") return fakeTracker;
        if (pkg === "@jleechanorg/ao-plugin-scm-gitlab") return fakeScm;
        throw new Error(`Not found: ${pkg}`);
      },
      async () => null,
    );

    expect(registry.list("tracker")).toContainEqual(
      expect.objectContaining({ name: "gitlab", slot: "tracker" }),
    );
    expect(registry.list("scm")).toContainEqual(
      expect.objectContaining({ name: "gitlab", slot: "scm" }),
    );
  });

  it("passes configured notifier plugin config to create()", async () => {
    const registry = createPluginRegistry();
    const fakeWebhookNotifier = makePlugin("notifier", "webhook");
    const config = makeOrchestratorConfig({
      notifiers: {
        webhook: {
          plugin: "webhook",
          url: "http://127.0.0.1:8787/hook",
          retries: 2,
          retryDelayMs: 500,
        },
      },
    });

    await registry.loadBuiltins(
      config,
      async (pkg: string) => {
        if (pkg === "@jleechanorg/ao-plugin-notifier-webhook") return fakeWebhookNotifier;
        throw new Error(`Not found: ${pkg}`);
      },
      async () => null,
    );

    expect(fakeWebhookNotifier.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8787/hook",
      retries: 2,
      retryDelayMs: 500,
    });
  });

  it("matches notifier config by plugin name instead of instance key", async () => {
    const registry = createPluginRegistry();
    const fakeWebhookNotifier = makePlugin("notifier", "webhook");
    const config = makeOrchestratorConfig({
      notifiers: {
        "my-webhook": {
          plugin: "webhook",
          url: "http://127.0.0.1:8787/custom-hook",
          retries: 4,
        },
      },
    });

    await registry.loadBuiltins(
      config,
      async (pkg: string) => {
        if (pkg === "@jleechanorg/ao-plugin-notifier-webhook") return fakeWebhookNotifier;
        throw new Error(`Not found: ${pkg}`);
      },
      async () => null,
    );

    expect(fakeWebhookNotifier.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8787/custom-hook",
      retries: 4,
    });
  });

  it("passes notifier config from config.notifiers when loading builtins", async () => {
    const registry = createPluginRegistry();
    const fakeOpenClaw = makePlugin("notifier", "openclaw");
    const cfg = makeOrchestratorConfig({
      notifiers: {
        openclaw: {
          plugin: "openclaw",
          url: "http://127.0.0.1:18789/hooks/agent",
          token: "tok",
        },
      },
    });

    await registry.loadBuiltins(
      cfg,
      async (pkg: string) => {
        if (pkg === "@jleechanorg/ao-plugin-notifier-openclaw") return fakeOpenClaw;
        throw new Error(`Not found: ${pkg}`);
      },
      async () => null,
    );

    expect(fakeOpenClaw.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:18789/hooks/agent",
      token: "tok",
    });
  });

  it("does not match notifier key when explicit plugin points to another notifier", async () => {
    const registry = createPluginRegistry();
    const fakeOpenClaw = makePlugin("notifier", "openclaw");
    const fakeWebhook = makePlugin("notifier", "webhook");
    const cfg = makeOrchestratorConfig({
      notifiers: {
        openclaw: {
          plugin: "webhook",
          url: "http://127.0.0.1:8787/hook",
          retries: 3,
        },
      },
    });

    await registry.loadBuiltins(
      cfg,
      async (pkg: string) => {
        if (pkg === "@jleechanorg/ao-plugin-notifier-openclaw") return fakeOpenClaw;
        if (pkg === "@jleechanorg/ao-plugin-notifier-webhook") return fakeWebhook;
        throw new Error(`Not found: ${pkg}`);
      },
      async () => null,
    );

    expect(fakeOpenClaw.create).toHaveBeenCalledWith(undefined);
    expect(fakeWebhook.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8787/hook",
      retries: 3,
    });
  });
});

describe("extractPluginConfig (via register with config)", () => {
  // extractPluginConfig is tested indirectly: we verify that register()
  // correctly passes config through, and that loadBuiltins() would call
  // extractPluginConfig for known slot:name pairs. The actual config
  // forwarding logic is validated in workspace plugin unit tests.

  it("register passes config to plugin create()", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("workspace", "worktree");

    registry.register(plugin, { worktreeDir: "/custom/path" });

    expect(plugin.create).toHaveBeenCalledWith({ worktreeDir: "/custom/path" });
  });

  it("register passes undefined config when none provided", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("workspace", "clone");

    registry.register(plugin);

    expect(plugin.create).toHaveBeenCalledWith(undefined);
  });
});

describe("loadFromConfig", () => {
  it("does not throw when no plugins are importable", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({});

    // loadFromConfig calls loadBuiltins internally, which may fail to
    // import packages in the test env — should still succeed gracefully.
    // Pass a mock importFn that always throws to avoid real npm imports in test.
    await expect(
      registry.loadFromConfig(
        config,
        async () => {
          throw new Error("package not found");
        },
        async () => null,
      ),
    ).resolves.toBeUndefined();
  });
});
