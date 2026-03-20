/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@jleechanorg/ao-core",
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
