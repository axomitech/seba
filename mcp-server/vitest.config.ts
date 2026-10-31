import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,   // integration files share one database
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
