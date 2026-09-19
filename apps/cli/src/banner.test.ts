import { describe, it, expect } from "vitest";
import { banner, type AuditRow } from "./banner.ts";

const brandNoKey = (name: string): AuditRow =>
  ({ name, state: "failed", failReason: "配置校验失败：apiKey: Invalid input: expected string, received undefined" });
const active = (name: string): AuditRow => ({ name, state: "active" });

describe("降级横幅分级（M4-B7 提前落地，走查：已配 provider 后品牌无 key 每次启动刷 4 行噪音）", () => {
  it("① 已有可用 provider + 失败全为品牌缺 key → 单行静默提示（无 ⚠、无逐行明细）", () => {
    const rows = [brandNoKey("provider-anthropic"), brandNoKey("provider-deepseek"), brandNoKey("provider-glm"), brandNoKey("provider-kimi"), active("provider-custom"), active("tool-fs")];
    const out = banner({ graph: () => ({ audit: () => rows }) });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("4 个品牌适配器未配 key");
    expect(out[0]).toContain("--dump-modules");
    expect(out.join("\n")).not.toContain("⚠");
    expect(out.join("\n")).not.toContain("provider-anthropic:");
  });

  it("② 有真坏件（非缺 key 失败）→ 保持吵闹横幅逐行列出", () => {
    const rows = [brandNoKey("provider-glm"), { name: "mcp", state: "failed", failReason: "连接超时" }, active("provider-custom"), active("tool-fs")];
    const out = banner({ graph: () => ({ audit: () => rows }) });
    expect(out[0]).toContain("⚠ 2 个模块降级");
    expect(out.join("\n")).toContain("mcp: 连接超时");
    expect(out.join("\n")).toContain("provider-glm:");
  });

  it("③ 零配置首跑（model 未配置、失败全为品牌缺 key）→ 引导语指路 /provider，不再吓人 ⚠（M4-2 T15/B7 剩余）", () => {
    const rows = [brandNoKey("provider-anthropic"), brandNoKey("provider-glm"), active("tool-fs"), active("skill")];
    const out = banner({ graph: () => ({ audit: () => rows }) }, { modelConfigured: false });
    expect(out.join("\n")).toContain("尚未配置");
    expect(out.join("\n")).toContain("/provider");
    expect(out.join("\n")).not.toContain("⚠");
  });

  it("③b 零失败且 model 未配置（--no-modules 形态）→ 同样引导语", () => {
    const rows = [active("tool-fs")];
    const out = banner({ graph: () => ({ audit: () => rows }) }, { modelConfigured: false });
    expect(out.join("\n")).toContain("尚未配置");
    expect(out.join("\n")).toContain("/provider");
  });

  it("④ 全员健康 → 原激活行不变；dumpModules 模式零输出", () => {
    const rows = [active("provider-custom"), active("tool-fs")];
    expect(banner({ graph: () => ({ audit: () => rows }) })).toEqual(["[orosus] 2 个模块已激活"]);
    expect(banner({ graph: () => ({ audit: () => rows }) }, { dumpModules: true })).toEqual([]);
  });
});
