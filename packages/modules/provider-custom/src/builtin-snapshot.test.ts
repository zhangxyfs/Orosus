import { describe, it, expect } from "vitest";
import { snapshotProviderView } from "./builtin-snapshot.ts";

describe("引导第 2 页快照裁剪视图（M4-3 T1d/SW-21）", () => {
  it("字段裁剪（id/name/envKey/baseUrl——不嵌模型清单）+ ≤20 家；ollama/本地服务已退役（2026-10-02 拍板）", () => {
    const view = snapshotProviderView();
    expect(view.length).toBeGreaterThan(0);
    expect(view.length).toBeLessThanOrEqual(20);
    for (const p of view) {
      expect(p).not.toHaveProperty("models"); // 模型列表仍走既有目录管道（SW-21 不嵌模型级清单）
      expect(p).not.toHaveProperty("local"); // 本地服务概念已退役
      expect(p.baseUrl.length).toBeGreaterThan(0);
      expect(p.envKey).toBeDefined(); // 全部为需 Key 云厂商
    }
    expect(view.find((p) => p.id === "ollama")).toBeUndefined(); // 2026-10-02 拍板移除
    const anthropic = view.find((p) => p.id === "anthropic");
    expect(anthropic).toMatchObject({ type: "anthropic", envKey: "ANTHROPIC_API_KEY" });
  });
});
