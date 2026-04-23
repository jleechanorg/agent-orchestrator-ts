import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function installMockOpencode(
  tmpDir: string,
  sessionListJson: string,
  deleteLogPath: string,
  listDelaySeconds = 0,
  listLogPath?: string,
): string {
  const binDir = join(tmpDir, "mock-bin");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "opencode");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "$1" == "session" && "$2" == "list" ]]; then',
      listLogPath ? `  printf '%s\n' "$*" >> '${listLogPath.replace(/'/g, "'\\''")}'` : "",
      listDelaySeconds > 0 ? `  sleep ${listDelaySeconds}` : "",
      `  printf '%s\n' '${sessionListJson.replace(/'/g, "'\\''")}'`,
      "  exit 0",
      "fi",
      'if [[ "$1" == "session" && "$2" == "delete" ]]; then',
      `  printf '%s\n' "$*" >> '${deleteLogPath.replace(/'/g, "'\\''")}'`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(scriptPath, 0o755);
  return binDir;
}

export function installMockOpencodeSequence(
  tmpDir: string,
  sessionListJsons: string[],
  deleteLogPath: string,
  listLogPath?: string,
): string {
  const binDir = join(tmpDir, "mock-bin-sequence");
  mkdirSync(binDir, { recursive: true });
  const sequencePath = join(binDir, ".list-counter");
  writeFileSync(sequencePath, "0\n", "utf-8");

  const scriptPath = join(binDir, "opencode");
  const cases = sessionListJsons
    .map((entry, index) => {
      const escaped = entry.replace(/'/g, "'\\''");
      return `if [[ "$idx" == "${index}" ]]; then printf '%s\\n' '${escaped}'; exit 0; fi`;
    })
    .join("\n");
  const final = sessionListJsons.at(-1)?.replace(/'/g, "'\\''") ?? "[]";

  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "$1" == "session" && "$2" == "list" ]]; then',
      listLogPath ? `  printf '%s\\n' "$*" >> '${listLogPath.replace(/'/g, "'\\''")}'` : "",
      `  seq_file='${sequencePath.replace(/'/g, "'\\''")}'`,
      '  idx=$(cat "$seq_file")',
      "  next=$((idx + 1))",
      '  printf "%s\\n" "$next" > "$seq_file"',
      `  ${cases}`,
      `  printf '%s\\n' '${final}'`,
      "  exit 0",
      "fi",
      'if [[ "$1" == "session" && "$2" == "delete" ]]; then',
      `  printf '%s\\n' "$*" >> '${deleteLogPath.replace(/'/g, "'\\''")}'`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(scriptPath, 0o755);
  return binDir;
}
