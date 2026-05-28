const TERMINAL_SESSION_STATES: ReadonlySet<string> = new Set([
  "done",
  "terminated",
  "killed",
  "merged",
  "cleanup",
]);

export function clearTerminalMarkersForNonTerminalState(
  metadata: Record<string, string>,
): void {
  const status = metadata["status"];
  if (!status || TERMINAL_SESSION_STATES.has(status)) return;
  delete metadata["completedAt"];
  delete metadata["terminatedAt"];
}
