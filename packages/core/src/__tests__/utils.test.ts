import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isRetryableHttpStatus, normalizeRetryConfig, readLastJsonlEntry, readLastJsonEntry } from "../utils.js";
import { parsePrFromUrl } from "../utils/pr.js";

describe("readLastJsonlEntry", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(content: string, filename = "test.jsonl", mtime = new Date(1700000000000)): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-utils-test-"));
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, content, "utf-8");
    utimesSync(filePath, mtime, mtime);
    return filePath;
  }

  it("returns null for empty file", async () => {
    const path = setup("");
    expect(await readLastJsonlEntry(path)).toBeNull();
  });

  it("returns null for nonexistent file", async () => {
    expect(await readLastJsonlEntry("/tmp/nonexistent-ao-test.jsonl")).toBeNull();
  });

  it("reads last entry type from single-line JSONL", async () => {
    const path = setup('{"type":"assistant","message":"hello"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBe("assistant");
  });

  it("reads last entry from multi-line JSONL", async () => {
    const path = setup(
      '{"type":"human","text":"hi"}\n{"type":"assistant","text":"hello"}\n{"type":"result","text":"done"}\n',
    );
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("result");
  });

  it("handles trailing newlines", async () => {
    const path = setup('{"type":"done"}\n\n\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("done");
  });

  it("returns lastType null for entry without type field", async () => {
    const path = setup('{"message":"no type"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const path = setup("not json at all\n");
    expect(await readLastJsonlEntry(path)).toBeNull();
  });

  it("handles multi-byte UTF-8 characters in JSONL entries", async () => {
    // Create a JSONL entry with multi-byte characters (CJK, emoji)
    const entry = { type: "assistant", text: "日本語テスト 🎉 données résumé" };
    const path = setup(JSON.stringify(entry) + "\n");
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("assistant");
  });

  it("handles multi-byte UTF-8 at chunk boundaries", async () => {
    // Create content larger than the 4096 byte chunk size with multi-byte
    // characters that could straddle a boundary. Each 🎉 is 4 bytes.
    const padding = '{"type":"padding","data":"' + "x".repeat(4080) + '"}\n';
    // The emoji-heavy last line will be at a chunk boundary
    const lastLine = { type: "final", text: "🎉".repeat(100) };
    const path = setup(padding + JSON.stringify(lastLine) + "\n");
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("final");
  });

  it("returns modifiedAt as a Date", async () => {
    const path = setup('{"type":"test"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.modifiedAt).toBeInstanceOf(Date);
  });

  it("reads subtype and level from JSONL entry", async () => {
    const path = setup('{"type":"assistant","subtype":"text","level":"info"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastSubtype).toBe("text");
    expect(result!.lastLevel).toBe("info");
  });

  it("returns null subtype/level when entry lacks those fields", async () => {
    const path = setup('{"type":"assistant"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastSubtype).toBeNull();
    expect(result!.lastLevel).toBeNull();
  });

  it("reads payloadType from nested payload object", async () => {
    const path = setup('{"type":"system","payload":{"type":"api_error"}}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.payloadType).toBe("api_error");
  });

  it("returns null payloadType when payload has no type field", async () => {
    const path = setup('{"type":"system","payload":{"data":"x"}}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.payloadType).toBeNull();
  });

  it("returns null payloadType when payload is not an object", async () => {
    const path = setup('{"type":"system","payload":"string-payload"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.payloadType).toBeNull();
  });

  it("returns all new fields as null for entry without type field", async () => {
    const path = setup('{"message":"no type"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBeNull();
    expect(result!.payloadType).toBeNull();
    expect(result!.lastSubtype).toBeNull();
    expect(result!.lastLevel).toBeNull();
  });
});

describe("readLastJsonEntry", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(content: string, filename = "test.json", mtime = new Date(1700000000000)): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-utils-test-"));
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, content, "utf-8");
    utimesSync(filePath, mtime, mtime);
    return filePath;
  }

  it("returns null for empty file", async () => {
    const path = setup("");
    expect(await readLastJsonEntry(path)).toBeNull();
  });

  it("returns null for nonexistent file", async () => {
    expect(await readLastJsonEntry("/tmp/nonexistent-ao-test.json")).toBeNull();
  });

  it("reads last entry type from Gemini-style JSON session files", async () => {
    const mtime = new Date(1700000001000);
    const path = setup(
      JSON.stringify({
        sessionId: "sess-1",
        messages: [
          { type: "user", content: "start" },
          { type: "gemini", content: "done" },
        ],
      }),
      "test.json",
      mtime,
    );
    const result = await readLastJsonEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBe("gemini");
    expect(result!.modifiedAt.getTime()).toBe(mtime.getTime());
  });

  it("returns null for an empty messages array", async () => {
    const path = setup(JSON.stringify({ messages: [] }));
    expect(await readLastJsonEntry(path)).toBeNull();
  });

  it("returns null when the messages field is missing", async () => {
    const path = setup(JSON.stringify({ sessionId: "sess-1" }));
    expect(await readLastJsonEntry(path)).toBeNull();
  });

  it("returns lastType null when the last message has no string type", async () => {
    const path = setup(
      JSON.stringify({
        messages: [{ type: "user" }, { content: "missing type" }],
      }),
    );
    const result = await readLastJsonEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const path = setup("{not valid json");
    expect(await readLastJsonEntry(path)).toBeNull();
  });
});

describe("retry utilities", () => {
  it("marks 429 and 5xx statuses as retryable", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
  });

  it("marks 4xx statuses (except 429) as non-retryable", () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it("normalizes retry config with defaults", () => {
    expect(normalizeRetryConfig(undefined)).toEqual({ retries: 2, retryDelayMs: 1000 });
  });

  it("normalizes retry config values and clamps invalid input", () => {
    expect(normalizeRetryConfig({ retries: 4, retryDelayMs: 250 })).toEqual({
      retries: 4,
      retryDelayMs: 250,
    });
    expect(normalizeRetryConfig({ retries: -1, retryDelayMs: -50 })).toEqual({
      retries: 0,
      retryDelayMs: 1000,
    });
  });
});

describe("parsePrFromUrl", () => {
  it("parses GitHub PR URLs", () => {
    expect(parsePrFromUrl("https://github.com/foo/bar/pull/123")).toEqual({
      owner: "foo",
      repo: "bar",
      number: 123,
      url: "https://github.com/foo/bar/pull/123",
    });
  });

  it("falls back to trailing number for non-GitHub URLs", () => {
    expect(parsePrFromUrl("https://gitlab.com/foo/bar/-/merge_requests/456")).toEqual({
      owner: "",
      repo: "",
      number: 456,
      url: "https://gitlab.com/foo/bar/-/merge_requests/456",
    });
  });

  it("returns null when the URL has no PR number", () => {
    expect(parsePrFromUrl("https://example.com/foo/bar/pull/not-a-number")).toBeNull();
  });
});
