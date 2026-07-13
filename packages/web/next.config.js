import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // NOTE: lazyCompilation and workers are disabled — they crash on Linux (2026-07-12).
    // lazyCompilation: true,  // hangs first HTTP request until compile completes
    // workers: true,          // worker processes exit immediately, taking server with them
  },
  serverExternalPackages: ["@composio/core", "@jleechanorg/ao-core", "better-sqlite3"],
  // Fix lockfile warning by specifying the correct root
  outputFileTracingRoot: __dirname,
  transpilePackages: [
    "@jleechanorg/ao-plugin-agent-claude-code",
    "@jleechanorg/ao-plugin-agent-cursor",
    "@jleechanorg/ao-plugin-agent-opencode",
    "@jleechanorg/ao-plugin-runtime-tmux",
    "@jleechanorg/ao-plugin-scm-github",
    "@jleechanorg/ao-plugin-tracker-github",
    "@jleechanorg/ao-plugin-tracker-linear",
    "@jleechanorg/ao-plugin-workspace-worktree",
  ],
};

export default nextConfig;
