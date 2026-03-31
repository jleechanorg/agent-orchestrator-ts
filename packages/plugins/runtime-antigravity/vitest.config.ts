import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests use real setTimeout delays (screencapture + python3 subprocess)
    // and retry loops with RETRY_DELAY_MS=1000ms, so 15s is a safe threshold.
    testTimeout: 15000,
  },
});
