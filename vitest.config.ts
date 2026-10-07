import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/modules/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "packages/modules/*/test/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // 真实子进程用例（tool-shell 后台作业/hooks 钩子往返/media worker）在机器负载下冷启可拖过默认
    // 5s——release-npm 批实锤（jobs.test ⑤ kill 树 5s 超时、用户常态负载连撞；load burner 复现）。
    // 15s 余量只影响超时判定、不拖慢绿测试（绝大多数 <1s）
    testTimeout: 15_000,
  },
});
