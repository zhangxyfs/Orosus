import { describe, it, expect } from "vitest";
import { toggleResultText } from "./module-toggle-result.ts";
import type { ReloadReport } from "@orosus/core";

const report = (over: Partial<ReloadReport>): ReloadReport => ({
  added: [], removed: [], reloaded: [], unchanged: [], failed: [], ...over,
});

describe("toggleResultText（热插拔 T2：toast 读失败清单，不再假报成功）", () => {
  it("failed 为空 → 现状文案不变（挂/卸两侧）", () => {
    expect(toggleResultText("mount", "tool-fs", report({ added: ["tool-fs"] })))
      .toBe("已挂载 tool-fs（reload：added tool-fs）");
    expect(toggleResultText("unmount", "tool-fs", report({ removed: ["tool-fs"] })))
      .toBe("已卸载 tool-fs（reload：removed tool-fs）");
  });

  it("failed 非空 → 明说失败与原因 + 连带 failed 名单（原因取各自行首）", () => {
    const r = report({
      failed: [
        { name: "tool-shell", reason: "提供者 fs 不可用（tool-fs 已降级）\n第二行不该出现" },
        { name: "mcp-x", reason: "激活抛错：boom" },
      ],
    });
    expect(toggleResultText("mount", "tool-shell", r))
      .toBe("挂载失败：tool-shell——提供者 fs 不可用（tool-fs 已降级） 连带失败：mcp-x（激活抛错：boom）");
    expect(toggleResultText("unmount", "tool-fs", r))
      .toBe("已卸载 tool-fs；连带失败：tool-shell（提供者 fs 不可用（tool-fs 已降级））、mcp-x（激活抛错：boom）");
  });
});
