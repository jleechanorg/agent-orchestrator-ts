/**
 * Fork-local ESLint config — extends the base config and adds fork-specific overrides.
 *
 * This file exists because `novel/**` is a fork-only pipeline not present in
 * upstream ComposioHQ/agent-orchestrator. The ignore is kept here rather than
 * in the upstream-shared eslint.config.js to minimize diff against upstream.
 *
 * Usage: eslint --config eslint.fork.config.js
 */
import baseConfig from "./eslint.config.js";

const forkIgnore = {
  ignores: ["novel/**"],
};

export default [...baseConfig, forkIgnore];
