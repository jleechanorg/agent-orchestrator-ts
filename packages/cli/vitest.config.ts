import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@jleechanorg/ao-plugin-agent-claude-code": resolve(
        __dirname,
        "../plugins/agent-claude-code/src/index.ts",
      ),
      "@jleechanorg/ao-plugin-agent-codex": resolve(
        __dirname,
        "../plugins/agent-codex/src/index.ts",
      ),
      "@jleechanorg/ao-plugin-agent-cursor": resolve(
        __dirname,
        "../plugins/agent-cursor/src/index.ts",
      ),
      "@jleechanorg/ao-plugin-agent-aider": resolve(
        __dirname,
        "../plugins/agent-aider/src/index.ts",
      ),
      "@jleechanorg/ao-plugin-agent-opencode": resolve(
        __dirname,
        "../plugins/agent-opencode/src/index.ts",
      ),
      "@jleechanorg/ao-plugin-agent-minimax": resolve(
        __dirname,
        "../plugins/agent-minimax/src/index.ts",
      ),
      "@jleechanorg/ao-plugin-scm-github": resolve(
        __dirname,
        "../plugins/scm-github/src/index.ts",
      ),
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    testTimeout: 15000,
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 8,
      },
    },
  },
});
