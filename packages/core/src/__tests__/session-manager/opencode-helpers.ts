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
  let callCount = 0;

  const scriptPath = join(binDir, "opencode");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "$1" == "session" && "$2" == "list" ]]; then',
      listLogPath ? `  printf '%s\n' "$*" >> '${listLogPath.replace(/'/g, "'\\''")}'` : "",
      `  idx=$((call_${listLogPath ? "count_seq" : "count"}_$(cat /dev/urandom | tr -dc 'a-z0-9' | head -c 8)))`,
      `  idx=$((idx % ${sessionListJsons.length}))`,
      `  printf '%s\n' '${sessionListJsons.map((j) => j.replace(/'/g, "'\\''")).join("'\n'")}'`,
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
