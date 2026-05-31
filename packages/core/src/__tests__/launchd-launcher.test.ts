import { describe, expect, it } from "vitest";
import { exec } from "child_process";
import path from "path";
import fs from "fs";

describe("launchd-launcher.sh environment stabilization", () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const launcherPath = path.join(repoRoot, "scripts/launchd-launcher.sh");

  it("successfully passes target script args and stabilizes PATH under restricted environments", () => {
    return new Promise<void>((resolve, reject) => {
      // Create a temporary target script that prints PATH and exits 0
      const tmpTargetScript = path.join(repoRoot, "packages/core/src/__tests__/tmp-target.sh");
      fs.writeFileSync(tmpTargetScript, `#!/bin/bash\necho "STABILIZED_PATH=$PATH"\nexit 0\n`, { mode: 0o755 });

      // Run launcher with extreme PATH restriction: empty PATH, but with HOME
      exec(
        `"${launcherPath}" "${tmpTargetScript}"`,
        {
          env: {
            HOME: process.env.HOME,
            // Provide a bare minimal PATH to trigger the fallback logic
            PATH: "/usr/bin:/bin",
            AO_REPO_ROOT: repoRoot,
          },
        },
        (error, stdout, stderr) => {
          // Cleanup
          try {
            fs.unlinkSync(tmpTargetScript);
          } catch {}

          if (error) {
            return reject(error);
          }

          console.log("Stdout:", stdout);
          console.log("Stderr:", stderr);

          try {
            // We expect the stabilized PATH to contain the critical fallback dirs
            expect(stdout).toContain("STABILIZED_PATH=");
            
            // Fallback PATH augmentation should have prepended common directories
            // such as /opt/homebrew/bin or /usr/local/bin or NVM default node bin
            const stabilizedPath = stdout.match(/STABILIZED_PATH=(.*)/)?.[1] || "";
            const pathDirs = stabilizedPath.split(":");
            
            expect(pathDirs).toContain("/opt/homebrew/bin");
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });
});
