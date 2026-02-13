/**
 * @agent-orchestrator/core
 *
 * Core library for the Agent Orchestrator.
 * Exports all types, config loader, and service implementations.
 */

// Types — everything plugins and consumers need
export * from "./types.js";

// Config — YAML loader + validation
export { loadConfig, validateConfig, getDefaultConfig } from "./config.js";

// Plugin registry
export { createPluginRegistry } from "./plugin-registry.js";
