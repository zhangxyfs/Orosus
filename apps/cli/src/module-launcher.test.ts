import { describe, expect, it } from "vitest";
import { collectLaunchers, EMPTY_LAUNCHER_TOAST, launcherRows } from "./module-launcher.ts";

describe("模块总览启动器（m5-peers T6e——A-1 极简版）", () => {
  const entry = (name: string, state: string, launcher?: { label: string; command?: string }) =>
    ({ name, state, launcher }) as never;

  it("① 收集 active 且登记了 launcher 的模块（discovered/未登记排除；按名稳定序）", () => {
    const out = collectLaunchers([
      entry("tool-peers", "active", { label: "记忆", command: "/tool-peers__memory" }),
      entry("skill", "active"),                                    // 未登记 UI
      entry("disabled-mod", "discovered", { label: "X", command: "/x" }),   // 未启用
      entry("another", "active", { label: "另一个", command: "/another__open" }),
    ]);
    expect(out).toEqual([
      { name: "another", label: "另一个", command: "/another__open" },
      { name: "tool-peers", label: "记忆", command: "/tool-peers__memory" },
    ]);
  });

  it("② 空/无登记 → 空数组（宿主 toast 空态文案）", () => {
    expect(collectLaunchers([])).toEqual([]);
    expect(collectLaunchers([entry("skill", "active")])).toEqual([]);
    expect(EMPTY_LAUNCHER_TOAST).toContain("没有可打开的模块界面");
  });

  it("③ launcher 行渲染：label + command 缺省占位", () => {
    const rows = launcherRows([
      { name: "tool-peers", label: "记忆", command: "/tool-peers__memory" },
      { name: "bare", label: "裸登记" },
    ]);
    expect(rows[0]).toContain("记忆");
    expect(rows[0]).toContain("/tool-peers__memory");
    expect(rows[1]).toContain("裸登记");
    expect(rows[1]).not.toContain("（未接命令）");   // 无 command 行不显示命令段（灰提示）——渲染层按需
  });
});
