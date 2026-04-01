import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.{test,spec}.ts",
      "src/**/test_*.ts",
      "src/**/*_test_*.ts",
    ],
  },
});
