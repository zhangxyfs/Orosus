import { describe, it, expect } from "vitest";
import { banner, type AuditRow } from "./banner.ts";

const active = (name: string): AuditRow => ({ name, state: "active" });

/** 「品牌适配器缺 key 静默降级」分支已随品牌 provider ×5 退役拆除（2026-09-23 provider 路线归一
 *  custom + 向导）——本组改钉拆除后的分级形态：零配置引导 / 真坏件吵闹 / 全员健康。 */
describe("降级横幅分级（M4-B7 提前落地；2026-09-23 品牌分支拆除后）", () => {
  it("① 零失败且 model 未配置（零配置首跑）→ 引导语指路 /provider，不再吓人 ⚠（M4-2 T15/B7 剩余）", () => {
    const rows = [active("tool-fs"), active("skill")];
    const out = banner({ graph: () => ({ audit: () => rows }) }, { modelConfigured: false });
    expect(out.join("\n")).toContain("尚未配置");
    expect(out.join("\n")).toContain("/provider");
    expect(out.join("\n")).not.toContain("⚠");
  });

  it("①b 有失败但 model 未配置（真坏件优先于引导）→ 保持吵闹横幅逐行列出", () => {
    const rows = [{ name: "mcp", state: "failed", failReason: "连接超时" }, active("provider-custom"), active("tool-fs")];
    const out = banner({ graph: () => ({ audit: () => rows }) });
    expect(out[0]).toContain("⚠ 1 个模块降级");
    expect(out.join("\n")).toContain("mcp: 连接超时");
  });

  it("② 有真坏件（model 已配置）→ 保持吵闹横幅逐行列出", () => {
    const rows = [{ name: "mcp", state: "failed", failReason: "连接超时" }, active("provider-custom"), active("tool-fs")];
    const out = banner({ graph: () => ({ audit: () => rows }) }, { modelConfigured: true });
    expect(out[0]).toContain("⚠ 1 个模块降级");
    expect(out.join("\n")).toContain("mcp: 连接超时");
  });

  it("③ 全员健康 → 原激活行不变；dumpModules 模式零输出", () => {
    const rows = [active("provider-custom"), active("tool-fs")];
    expect(banner({ graph: () => ({ audit: () => rows }) })).toEqual(["[orosus] 2 个模块已激活"]);
    expect(banner({ graph: () => ({ audit: () => rows }) }, { dumpModules: true })).toEqual([]);
  });
});
