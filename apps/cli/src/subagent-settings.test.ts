import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSubagentConfig, runSubagentApprovalSetting, runSubagentModelSetting, writeSubagentConfigKey } from "./subagent-settings.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const cfg = (): string => join(dir!, "config.toml");

describe("/settings 子代理分组 T12（决策 7/23：模型 + 审批模式 → [tool-subagent] 节）", () => {
  it("㊺ 节区感知读写删：既有节内改键保注释；缺节文件尾新建；删键 = 跟随（缺省态）；读缺文件 = 空", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-t12-"));
    writeFileSync(cfg(), [
      "# 用户注释——行级写不许洗掉",
      'provider = "custom/a"',
      "",
      "[approval]",
      'mode = "ask-risky"',
      "",
      "[tool-subagent]",
      'model = "custom/old"',
      "[compaction]",
      "enabled = true",
      "",
    ].join("\n"), "utf8");
    writeSubagentConfigKey("model", "custom/new-m", cfg()); // 既有节内改
    writeSubagentConfigKey("approvalMode", "auto", cfg());  // 既有节内插（下一节头之前）
    const after = readFileSync(cfg(), "utf8");
    expect(after).toContain("# 用户注释——行级写不许洗掉");
    expect(after).toContain('model = "custom/new-m"');
    expect(after).toContain('approvalMode = "auto"');
    expect(after.indexOf("approvalMode")).toBeGreaterThan(after.indexOf("[tool-subagent]"));
    expect(after.indexOf("approvalMode")).toBeLessThan(after.indexOf("[compaction]")); // 插在节内不落到别节
    expect(readSubagentConfig(cfg())).toEqual({ model: "custom/new-m", approvalMode: "auto" });

    writeSubagentConfigKey("approvalMode", null, cfg()); // 删键 = 回跟随
    expect(readSubagentConfig(cfg()).approvalMode).toBeUndefined();
    expect(readSubagentConfig(cfg()).model).toBe("custom/new-m"); // 邻键不伤

    writeSubagentConfigKey("approvalMode", "auto", join(dir!, "fresh.toml")); // 缺文件 = 尾新建节
    const fresh = readFileSync(join(dir!, "fresh.toml"), "utf8");
    expect(fresh).toContain("[tool-subagent]");
    expect(readSubagentConfig(join(dir!, "no-such.toml"))).toEqual({}); // 读缺文件 = 空
  });

  it("㊻ 两档设置流：审批三档菜单（当前值 ✓ / 跟随删键文案）+ 模型两段选（清除项回跟父）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-t12-"));
    writeFileSync(cfg(), "", "utf8");
    // 审批模式：初始无键 → 跟随 ✓ 在第一档；选「从不询问」写 auto；再选「跟随主对话」删键
    const chooseLog: { title: string; items: string[] }[] = [];
    const choose = async (title: string, items: string[]): Promise<string> => {
      chooseLog.push({ title, items });
      if (title.startsWith("子代理 · 审批模式")) {
        return items.find((i) => i.startsWith(chooseLog.length <= 1 ? "从不询问" : "跟随主对话"))!;
      }
      return items[0]!; // 模型流：单槽直达 → 清单首项
    };
    const r1 = await runSubagentApprovalSetting(choose, cfg());
    expect(r1).toContain("从不询问");
    expect(readSubagentConfig(cfg()).approvalMode).toBe("auto");
    const r2 = await runSubagentApprovalSetting(choose, cfg());
    expect(r2).toContain("跟随主对话（配置键已清除）");
    expect(readSubagentConfig(cfg()).approvalMode).toBeUndefined();
    expect(chooseLog[1]!.items[1]).toContain("✓"); // 第二轮：auto 是当前值 → 「从不询问」档（第二档）带 ✓

    // 模型流：单槽 + 清单 → 选首项写 slot/model；再走「清除」项回跟父
    const slots = [{ name: "custom", defaultModel: "m-default", listModels: async () => ["m-one", "m-two"] }];
    const pickFirst = async (_t: string, items: string[]): Promise<string> => items[0]!;
    writeFileSync(cfg(), "", "utf8");
    const m1 = await runSubagentModelSetting(pickFirst, cfg(), slots); // 首项 = 清除
    expect(m1).toContain("已清除");
    const pickModel = async (_t: string, items: string[]): Promise<string> => items.find((i) => i.startsWith("m-two")) ?? items[0]!;
    const m2 = await runSubagentModelSetting(pickModel, cfg(), slots);
    expect(m2).toContain("custom/m-two");
    expect(readSubagentConfig(cfg()).model).toBe("custom/m-two");
    const noSlots = await runSubagentModelSetting(pickFirst, cfg(), []);
    expect(noSlots).toContain("暂无可选平台"); // 无平台 = 指路 /provider，不配置也能用（跟父）
  });
});
