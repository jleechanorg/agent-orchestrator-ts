import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Documentation JSDoc examples", () => {
  it("contains the auto-picks suffix in terminal-test page JSDoc examples", () => {
    const filePath = path.resolve(__dirname, "../app/dev/terminal-test/page.tsx");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("- http://localhost:3020/dev/terminal-test (auto-picks two different sessions)");
  });

  it("contains the base JSDoc example in test-direct page JSDoc", () => {
    const filePath = path.resolve(__dirname, "../app/test-direct/page.tsx");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("- http://localhost:3020/test-direct");
  });
});
