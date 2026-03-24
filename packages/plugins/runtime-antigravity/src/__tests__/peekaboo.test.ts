import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";

// Mock node:child_process — execFile is promisified in peekaboo.ts
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  return { execFile: mockExecFile };
});

// Mock the queue to execute immediately (bypass serial queue for unit tests)
vi.mock("../queue.js", () => ({
  enqueue: <T>(fn: () => Promise<T>) => fn(),
  pendingCount: () => 0,
}));

// Get the mock reference. peekaboo.ts uses promisify(execFile), so we need
// to mock the callback-style execFile and intercept via promisify behavior.
// Since promisify(execFile) calls execFile with a callback, we mock it
// to call the callback with our controlled output.
const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

/** Set up execFile mock to call callback with success result. */
function mockSuccess(stdout: string) {
  mockExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr: "" });
    },
  );
}

/** Set up execFile mock to call callback with an error. */
function mockError(message: string) {
  mockExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null) => void,
    ) => {
      cb(new Error(message));
    },
  );
}

// Import after mocks are set up
import { windowList, see, click, paste, press } from "../peekaboo.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("windowList()", () => {
  it("parses JSON window list from peekaboo CLI", async () => {
    const windows = [
      {
        window_id: 1,
        title: "Manager",
        app: "Antigravity",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
      {
        window_id: 2,
        title: "Conversation",
        app: "Antigravity",
        bounds: { x: 100, y: 100, width: 600, height: 400 },
      },
    ];
    mockSuccess(JSON.stringify(windows));

    const result = await windowList("Antigravity");

    expect(result).toEqual(windows);
    expect(mockExecFile).toHaveBeenCalledWith(
      "peekaboo",
      ["list", "--app", "Antigravity", "--json"],
      { timeout: 15_000 },
      expect.any(Function),
    );
  });

  it("throws when peekaboo CLI fails", async () => {
    mockError("peekaboo not found");

    await expect(windowList("Antigravity")).rejects.toThrow(
      "peekaboo not found",
    );
  });
});

describe("see()", () => {
  it("parses see result with snapshot_id and ui_elements", async () => {
    const seeResult = {
      snapshot_id: "snap-123",
      ui_elements: [
        {
          id: "el-1",
          role: "AXButton",
          title: "Submit",
          value: "",
          bounds: { x: 10, y: 10, width: 100, height: 30 },
        },
      ],
    };
    mockSuccess(JSON.stringify(seeResult));

    const result = await see("Antigravity", 1);

    expect(result).toEqual(seeResult);
    expect(mockExecFile).toHaveBeenCalledWith(
      "peekaboo",
      ["see", "--app", "Antigravity", "--window-id", "1", "--json"],
      { timeout: 15_000 },
      expect.any(Function),
    );
  });
});

describe("click()", () => {
  it("sends click command with element and snapshot IDs", async () => {
    mockSuccess(JSON.stringify({ success: true }));

    const result = await click("Antigravity", 1, "el-1", "snap-123");

    expect(result).toEqual({ success: true });
    expect(mockExecFile).toHaveBeenCalledWith(
      "peekaboo",
      [
        "click",
        "--app",
        "Antigravity",
        "--window-id",
        "1",
        "--element-id",
        "el-1",
        "--snapshot-id",
        "snap-123",
        "--json",
      ],
      { timeout: 15_000 },
      expect.any(Function),
    );
  });
});

describe("paste()", () => {
  it("sends paste command with text", async () => {
    mockSuccess("");

    await paste("Antigravity", "Hello, world!");

    expect(mockExecFile).toHaveBeenCalledWith(
      "peekaboo",
      ["paste", "--app", "Antigravity", "--text", "Hello, world!"],
      { timeout: 15_000 },
      expect.any(Function),
    );
  });
});

describe("press()", () => {
  it("sends press command with key name", async () => {
    mockSuccess("");

    await press("Antigravity", "Return");

    expect(mockExecFile).toHaveBeenCalledWith(
      "peekaboo",
      ["press", "--app", "Antigravity", "--key", "Return"],
      { timeout: 15_000 },
      expect.any(Function),
    );
  });

  it("throws when press fails", async () => {
    mockError("key press failed");

    await expect(press("Antigravity", "Return")).rejects.toThrow(
      "key press failed",
    );
  });
});
