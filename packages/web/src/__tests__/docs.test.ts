import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Documentation JSDoc examples", () => {
  it("contains the auto-picks suffix in terminal-test page JSDoc examples", () => {
    const filePath = path.resolve(__dirname, "../app/dev/terminal-test/page.tsx");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("- http://localhost:3020/dev/terminal-test (auto-picks two different sessions)");
  });
});
