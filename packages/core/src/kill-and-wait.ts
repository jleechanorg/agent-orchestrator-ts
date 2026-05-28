import { killProcessTree } from "./platform.js";

const SIGTERM_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return !isProcessAlive(pid);
}

export async function killProcessTreeAndWait(
  pid: number,
  opts: { sigtermTimeoutMs?: number } = {},
): Promise<void> {
  if (pid <= 0) return;

  await killProcessTree(pid, "SIGTERM");
  const exited = await waitForExit(pid, opts.sigtermTimeoutMs ?? SIGTERM_WAIT_MS);
  if (exited) return;

  await killProcessTree(pid, "SIGKILL");
  await waitForExit(pid, 2_000);
}
