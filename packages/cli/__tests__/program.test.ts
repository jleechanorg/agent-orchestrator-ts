import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/program.js";

describe("ao program help", () => {
  it("includes quick workflow examples and the repo-local AO skill path", () => {
    const help = buildProgram().helpInformation();

    expect(help).toContain("ao start https://github.com/owner/repo");
    expect(help).toContain("ao spawn --project my-project --claim-pr 456");
    expect(help).toContain("skills/agent-orchestrator/SKILL.md");
    expect(help).toContain("bash scripts/setup.sh");
  });
});
