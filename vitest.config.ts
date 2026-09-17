import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/modules/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "packages/modules/*/test/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
