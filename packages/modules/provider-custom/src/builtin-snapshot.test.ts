import { describe, it, expect } from "vitest";
import { snapshotProviderView } from "./builtin-snapshot.ts";

describe("引导第 2 页快照裁剪视图（M4-3 T1d/SW-21）", () => {
  it("字段裁剪（id/name/envKey/baseUrl/local——不嵌模型清单）+ 本地标记 + ≤20 家", () => {
    const view = snapshotProviderView();
    expect(view.length).toBeGreaterThan(0);
    expect(view.length).toBeLessThanOrEqual(20);
    for (const p of view) {
      expect(p).not.toHaveProperty("models"); // 模型列表仍走既有目录管道（SW-21 不嵌模型级清单）
      expect(p.baseUrl.length).toBeGreaterThan(0);
      if (p.local) expect(p.envKey).toBeUndefined(); // 本地服务免 Key = 无 env 声明
      else expect(p.envKey).toBeDefined();
    }
    const ollama = view.find((p) => p.id === "ollama");
    expect(ollama?.local).toBe(true);
    const anthropic = view.find((p) => p.id === "anthropic");
    expect(anthropic).toMatchObject({ type: "anthropic", local: false, envKey: "ANTHROPIC_API_KEY" });
  });
});
