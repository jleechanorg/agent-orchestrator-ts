export type CallerType = "human" | "orchestrator" | "agent";

export interface CallerContextOpts {
  callerType: CallerType;
  sessionId?: string;
  projectId?: string;
  configPath?: string;
  port?: number;
}

/**
 * Detect who is calling the CLI.
 * - If AO_CALLER_TYPE is set, trust it.
 * - Otherwise, if stdout is a TTY, it's a human.
 * - Non-TTY defaults to "agent".
 */
export function getCallerType(): CallerType {
  const env = process.env["AO_CALLER_TYPE"];
  if (env === "orchestrator" || env === "agent" || env === "human") {
    return env;
  }
  return process.stdout.isTTY ? "human" : "agent";
}

/**
 * Returns true if the caller is a human (interactive terminal).
 */
export function isHumanCaller(): boolean {
  return getCallerType() === "human";
}

/**
 * Inject AO context environment variables into an env record.
 * Used when spawning orchestrator/agent sessions so they know their context.
 */
export function setCallerContext(
  env: Record<string, string>,
  opts: CallerContextOpts,
): void {
  env["AO_CALLER_TYPE"] = opts.callerType;
  if (opts.sessionId) env["AO_SESSION_ID"] = opts.sessionId;
  if (opts.projectId) env["AO_PROJECT_ID"] = opts.projectId;
  if (opts.configPath) env["AO_CONFIG_PATH"] = opts.configPath;
  if (opts.port !== undefined && opts.port !== null) env["AO_PORT"] = String(opts.port);
}
