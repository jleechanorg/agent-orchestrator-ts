/**
 * Entry points for the Antigravity runtime.
 *
 * Provides CLI argument parsing and Slack message parsing
 * for spawning Antigravity conversations.
 */

export interface SpawnRequest {
  task: string;
  repo?: string;
  model?: string;
  mode?: "Planning" | "Fast";
}

/**
 * Parse CLI arguments for `ao spawn --runtime antigravity`.
 *
 * Expected format:
 *   ao spawn --runtime antigravity --repo ao "write design for X"
 *   ao spawn --runtime antigravity "add a README"
 */
export function parseCliArgs(args: string[]): SpawnRequest {
  let repo: string | undefined;
  let model: string | undefined;
  let mode: "Planning" | "Fast" | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo" && i + 1 < args.length) {
      repo = args[++i];
    } else if (arg === "--model" && i + 1 < args.length) {
      model = args[++i];
    } else if (arg === "--mode" && i + 1 < args.length) {
      const val = args[++i];
      if (val === "Planning" || val === "Fast") {
        mode = val;
      }
    } else if (arg.startsWith("--") && i + 1 < args.length) {
      // Skip unknown flag and its value
      i++;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  const task = positional.join(" ").trim();
  if (!task) {
    throw new Error("Task is required: ao spawn --runtime antigravity <task>");
  }

  return { task, repo, model, mode };
}

/**
 * Parse a Slack message for Antigravity spawn commands.
 *
 * Expected format:
 *   antigravity: <task> in repo: <name>
 *   antigravity: <task>
 */
export function parseSlackMessage(text: string): SpawnRequest | null {
  const match = text.match(
    /^antigravity:\s*(.+?)(?:\s+in\s+repo:\s*(\S+))?\s*$/i,
  );
  if (!match) return null;

  const task = match[1].trim();
  const repo = match[2]?.trim();

  if (!task) return null;
  return { task, repo };
}
