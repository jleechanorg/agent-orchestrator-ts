import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["integration/**/*_test.ts", "integration/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@jleechanorg/ao-core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
});
