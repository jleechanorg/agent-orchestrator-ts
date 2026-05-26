import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    lazyCompilation: true,
    // Optimize worker memory usage
    workers: true,
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
