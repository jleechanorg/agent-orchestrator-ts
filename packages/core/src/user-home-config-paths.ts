/**
 * User-home config file path candidates (canonical OpenClaw layout).
 * Kept out of config.ts to satisfy structural "fork isolation" tests that flag
 * vendor-specific path strings in high-churn core files.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Paths checked before legacy ~/.agent-orchestrator.* names. */
export function getOpenClawLayoutHomeConfigPaths(): string[] {
  const h = homedir();
  return [
    resolve(h, ".openclaw_prod", "agent-orchestrator.yaml"),
    resolve(h, ".openclaw", "agent-orchestrator.yaml"),
  ];
}
