import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  installMockOpencode,
  installMockOpencodeSequence,
} from "./opencode-helpers.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("opencode helper scripts", () => {
  it("installs a mock opencode binary that logs list/delete invocations and emits JSON", () => {
    const tmpDir = makeTempDir("opencode-helper-");
    const deleteLogPath = join(tmpDir, "delete'o.log");
    const listLogPath = join(tmpDir, "list'o.log");
    const sessionListJson = JSON.stringify([{ id: "sess-1", title: "O'Reilly" }]);

    const binDir = installMockOpencode(tmpDir, sessionListJson, deleteLogPath, 0.01, listLogPath);
    const binary = join(binDir, "opencode");

    const listed = execFileSync(binary, ["session", "list"], { encoding: "utf-8" });
    expect(JSON.parse(listed)).toEqual([{ id: "sess-1", title: "O'Reilly" }]);
    expect(readFileSync(listLogPath, "utf-8").trim()).toBe("session list");

    execFileSync(binary, ["session", "delete", "sess-1"], { encoding: "utf-8" });
    expect(readFileSync(deleteLogPath, "utf-8").trim()).toBe("session delete sess-1");
  });

  it("returns sequential session payloads, falls back to the last payload, and supports empty sequences", () => {
    const tmpDir = makeTempDir("opencode-sequence-");
    const deleteLogPath = join(tmpDir, "delete.log");
    const listLogPath = join(tmpDir, "list.log");
    const sessionListJsons = [
      JSON.stringify([{ id: "sess-1" }]),
      JSON.stringify([{ id: "sess-2" }]),
    ];

    const binDir = installMockOpencodeSequence(tmpDir, sessionListJsons, deleteLogPath, listLogPath);
    const binary = join(binDir, "opencode");

    expect(JSON.parse(execFileSync(binary, ["session", "list"], { encoding: "utf-8" }))).toEqual([{ id: "sess-1" }]);
    expect(JSON.parse(execFileSync(binary, ["session", "list"], { encoding: "utf-8" }))).toEqual([{ id: "sess-2" }]);
    expect(JSON.parse(execFileSync(binary, ["session", "list"], { encoding: "utf-8" }))).toEqual([{ id: "sess-2" }]);
    expect(readFileSync(listLogPath, "utf-8").trim().split("\n")).toEqual([
      "session list",
      "session list",
      "session list",
    ]);

    execFileSync(binary, ["session", "delete", "sess-2"], { encoding: "utf-8" });
    expect(readFileSync(deleteLogPath, "utf-8").trim()).toBe("session delete sess-2");

    const emptyDir = makeTempDir("opencode-sequence-empty-");
    const emptyDeleteLogPath = join(emptyDir, "delete.log");
    const emptyBinDir = installMockOpencodeSequence(emptyDir, [], emptyDeleteLogPath);
    const emptyBinary = join(emptyBinDir, "opencode");

    expect(JSON.parse(execFileSync(emptyBinary, ["session", "list"], { encoding: "utf-8" }))).toEqual([]);
  });
});
