export type CallerType = "human" | "orchestrator" | "agent";

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
 * Present a labeled menu and return the selected value.
 */
export async function promptSelect(
  prompt: string,
  options: Array<{ value: string; label: string }>,
): Promise<string> {
  if (options.length === 0) {
    throw new Error("promptSelect requires at least one option");
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(prompt);
  options.forEach((opt, i) => {
    console.log(`  ${i + 1}. ${opt.label}`);
  });
  try {
    const choice = await rl.question("  Choice: ");
    const idx = parseInt(choice.trim()) - 1;
    return options[idx]?.value ?? options[options.length - 1]!.value;
  } finally {
    rl.close();
  }
}
