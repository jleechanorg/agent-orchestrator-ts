let _dbUnavailableWarningEmitted = false;

function isAoEventsInvocation(argv = process.argv): boolean {
  return argv.slice(2).includes("events");
}

function isMissingBetterSqlite3Binding(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Could not locate the bindings file") ||
    message.includes("better_sqlite3.node") ||
    message.includes("Cannot find module 'better-sqlite3'")
  );
}

function firstErrorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0] ?? "unknown error";
}

export function formatActivityEventsDbUnavailableWarning(err: unknown): string {
  if (isMissingBetterSqlite3Binding(err)) {
    return `[ao] activity-events disabled: better-sqlite3 not compiled for Node ${process.version} (ABI v${process.versions.modules}). Run \`pnpm rebuild better-sqlite3\` or use a supported Node version.`;
  }
  return `[ao] activity-events disabled: better-sqlite3 failed to load: ${firstErrorLine(err)}`;
}

export function emitActivityEventsDbUnavailableWarning(err: unknown): void {
  if (_dbUnavailableWarningEmitted) return;
  if (process.env["AO_DEBUG"] !== "1" && !isAoEventsInvocation()) return;
  _dbUnavailableWarningEmitted = true;
  process.stderr.write(`${formatActivityEventsDbUnavailableWarning(err)}\n`);
}

export function __resetActivityEventsDbWarningForTests(): void {
  _dbUnavailableWarningEmitted = false;
}
