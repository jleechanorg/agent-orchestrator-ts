import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Documentation JSDoc examples", () => {
  it("contains all 3020 URL examples in terminal-test page JSDoc", () => {
    const filePath = path.resolve(__dirname, "../app/dev/terminal-test/page.tsx");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("- http://localhost:3020/dev/terminal-test (auto-picks two different sessions)");
    expect(content).toContain("- http://localhost:3020/dev/terminal-test?old_session=ao-orchestrator&new_session=ao-20");
    expect(content).toContain("- http://localhost:3020/dev/terminal-test?session=ao-20 (uses same session for both)");
  });

  it("contains the base JSDoc example in test-direct page JSDoc", () => {
    const filePath = path.resolve(__dirname, "../app/test-direct/page.tsx");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("- http://localhost:3020/test-direct");
    expect(content).toContain("- http://localhost:3020/test-direct?session=ao-20");
    expect(content).toContain("- http://localhost:3020/test-direct?session=ao-20&fullscreen=true");
  });
});

// NOTE: This file documents the JSDoc URL port alignment between dev/terminal-test
// and test-direct pages. See PR #680 for the rationale.
