import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    alias: {
      // Integration tests import real plugins. These aliases resolve
      // package names to source files so we don't need circular devDeps
      // (plugins depend on core, core can't depend on plugins).
      "@jleechanorg/ao-plugin-tracker-github": resolve(
        __dirname,
        "../plugins/tracker-github/src/index.ts",
      ),
      "@jleechanorg/ao-plugin-scm-github": resolve(__dirname, "../plugins/scm-github/src/index.ts"),
      // Plugins re-import @jleechanorg/ao-core; resolve to source so
      // tests work without a prior `pnpm build` producing dist/.
      "@jleechanorg/ao-core/scm-webhook-utils": resolve(__dirname, "src/scm-webhook-utils.ts"),
      "@jleechanorg/ao-core/types": resolve(__dirname, "src/types.ts"),
      "@jleechanorg/ao-core/utils": resolve(__dirname, "src/utils.ts"),
      "@jleechanorg/ao-core": resolve(__dirname, "src/index.ts"),
    },
  },
});
