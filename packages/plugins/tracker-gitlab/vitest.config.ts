import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@jleechanorg/ao-plugin-scm-gitlab/glab-utils": resolve(
        here,
        "../scm-gitlab/src/glab-utils.ts",
      ),
    },
  },
});
