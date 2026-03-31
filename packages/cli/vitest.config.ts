import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    testTimeout: 15000,
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 8,
      },
    },
  },
});
