import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const REPO_ROOT = join(import.meta.dirname, "../../../");

describe("Onboarding Robustness", () => {
  describe("scripts/setup.sh", () => {
    it("should correctly detect non-interactive mode via CI/NONINTERACTIVE env vars", () => {
      const setupPath = join(REPO_ROOT, "scripts/setup.sh");
      const content = readFileSync(setupPath, "utf-8");
      expect(content).toContain('if [ -t 0 ] && [ "${CI}" != "true" ] && [ "${NONINTERACTIVE}" != "true" ]; then');
    });

    it("should use --frozen-lockfile for pnpm install", () => {
      const setupPath = join(REPO_ROOT, "scripts/setup.sh");
      const content = readFileSync(setupPath, "utf-8");
      expect(content).toContain("pnpm install --frozen-lockfile");
    });
  });

  describe("onboarding-test.yml python snippet", () => {
    it("should be valid python syntax and pick a free port", () => {
      const reservedFile = join(REPO_ROOT, "temp_reserved_ports");
      if (existsSync(reservedFile)) unlinkSync(reservedFile);

      // Snippet exactly as in onboarding-test.yml, but we must escape it for shell
      const snippet = `if True:
              import socket, os
              reserved = set()
              rf = os.environ.get('RESERVED_PORTS_FILE', '')
              if rf and os.path.exists(rf):
                  reserved = set(open(rf).read().split())
              for _ in range(20):
                  s = socket.socket()
                  s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
                  s.bind(('', 0))
                  p = str(s.getsockname()[1])
                  s.close()
                  if p not in reserved:
                      if rf:
                          open(rf, 'a').write(p + '\\n')
                      print(p)
                      break`;

      const output = execSync(`RESERVED_PORTS_FILE=${reservedFile} python3 -c "${snippet}"`, {
        encoding: "utf-8"
      }).trim();

      expect(parseInt(output)).toBeGreaterThan(1024);
      expect(readFileSync(reservedFile, "utf-8").trim()).toBe(output);

      unlinkSync(reservedFile);
    });

    it("should respect RESERVED_PORTS_FILE and avoid already used ports", () => {
      const reservedFile = join(REPO_ROOT, "temp_reserved_ports_2");
      writeFileSync(reservedFile, "9000\n9001\n");

      const snippet = `if True:
              import socket, os
              reserved = set()
              rf = os.environ.get('RESERVED_PORTS_FILE', '')
              if rf and os.path.exists(rf):
                  reserved = set(open(rf).read().split())
              for _ in range(20):
                  s = socket.socket()
                  s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
                  s.bind(('', 0))
                  p = str(s.getsockname()[1])
                  s.close()
                  if p not in reserved:
                      if rf:
                          open(rf, 'a').write(p + '\\n')
                      print(p)
                      break`;

      const output = execSync(`RESERVED_PORTS_FILE=${reservedFile} python3 -c "${snippet}"`, {
        encoding: "utf-8"
      }).trim();

      expect(output).not.toBe("9000");
      expect(output).not.toBe("9001");
      
      const lines = readFileSync(reservedFile, "utf-8").split("\n").filter(Boolean);
      expect(lines).toContain("9000");
      expect(lines).toContain("9001");
      expect(lines).toContain(output);

      unlinkSync(reservedFile);
    });
  });
});
