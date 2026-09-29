import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { readSubagentConfig, runSubagentApprovalSetting, runSubagentMaxTurnsSetting, runSubagentModelSetting, writeSubagentConfigKey } from "./subagent-settings.ts";

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
    // m4-8 T4：[tool-subagent] 已路由新家 modules.d/tool-subagent.toml——config.toml 分毫不动
    const after = readFileSync(join(dir!, "modules.d", "tool-subagent.toml"), "utf8");
    expect(readFileSync(cfg(), "utf8")).toContain("# 用户注释——行级写不许洗掉");
    expect(after).toContain('model = "custom/new-m"');
    expect(after).toContain('approvalMode = "auto"');
    expect(after.indexOf("approvalMode")).toBeGreaterThan(after.indexOf("[tool-subagent]"));
    expect(after.trimEnd().endsWith('approvalMode = "auto"')).toBe(true); // 节尾收（新家独占文件）
    expect(readSubagentConfig(cfg())).toEqual({ model: "custom/new-m", approvalMode: "auto" });

    writeSubagentConfigKey("approvalMode", null, cfg()); // 删键 = 回跟随
    expect(readSubagentConfig(cfg()).approvalMode).toBeUndefined();
    expect(readSubagentConfig(cfg()).model).toBe("custom/new-m"); // 邻键不伤

    const freshDir = mkdtempSync(join(tmpdir(), "orosus-t12f-")); // m4-8 T4：缺文件 = 路由建新家文件
    writeSubagentConfigKey("approvalMode", "auto", join(freshDir, "fresh.toml"));
    const fresh = readFileSync(join(freshDir, "modules.d", "tool-subagent.toml"), "utf8");
    rmSync(freshDir, { recursive: true, force: true });
    expect(fresh).toContain("[tool-subagent]");
    const bareDir = mkdtempSync(join(tmpdir(), "orosus-t12b-")); // 真空目录（无 config 也无 modules.d——同目录有新家时读到它是正确语义）
    try {
      expect(readSubagentConfig(join(bareDir, "no-such.toml"))).toEqual({}); // 读缺文件 = 空
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
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

  it("CM-11：model 值含引号/反斜杠/换行（厂商/目录网络数据）→ 写入转义、读回还原、整文件仍可被 smol-toml 解析（无新行注入）", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cm11-"));
    writeFileSync(cfg(), "# 注释\n[tool-subagent]\n", "utf8");
    const evil = 'x"\\y\n[evil]\nenabled = "1';
    writeSubagentConfigKey("model", evil, cfg());
    const raw = readFileSync(join(dir!, "modules.d", "tool-subagent.toml"), "utf8"); // m4-8 T4：新家
    expect(readFileSync(cfg(), "utf8")).toContain("# 注释"); // 单文件层不动（新家是独占文件无注释）
    expect(raw.match(/^model = /gm)).toHaveLength(1); // 换行被转义成 \n 字面量——无注入新行（旧实现可写出 [evil] 节）
    expect(raw).not.toMatch(/^\[evil\]$/m);
    expect(readSubagentConfig(cfg()).model).toBe(evil); // 读侧还原成对（转义不丢数据）
    expect(() => parse(raw)).not.toThrow(); // 落盘产物是真 TOML（旧实现含裸引号即损坏，下次解析失败）
    expect((parse(raw) as { "tool-subagent"?: { model?: string } })["tool-subagent"]?.model).toBe(evil);
    // maxTurns 数值口设防（CM-11 同源）：非法值前置拒绝，不走不带引号的注入路
    expect(() => writeSubagentConfigKey("maxTurns", '1" injection', cfg())).toThrow(/maxTurns 非法值/);
  });
describe("子代理轮数上限设置（双保险丝批 2026-09-27：/settings → 子代理 → 轮数上限）", () => {
	it("㊺d 菜单四档 + 自定义：跟随默认删键；不限写 -1；自定义 1-200；越值拒；数值键不带引号可读回", async () => {
		dir = mkdtempSync(join(tmpdir(), "orosus-t12b-"));
		writeFileSync(cfg(), "", "utf8");
		const chooseLog: { title: string; items: string[] }[] = [];
		let askReply = "";
		const choose = async (title: string, items: string[]): Promise<string> => {
			chooseLog.push({ title, items });
			if (title.includes("轮数上限")) {
				if (askReply === "") return items.find((i) => i.startsWith("不限"))!;
			 return items.find((i) => i.startsWith("自定义"))!;
			}
			return items[0]!;
		};
		const ask = async (_t: string): Promise<string> => askReply;

		let r = await runSubagentMaxTurnsSetting(choose, ask, cfg());
		expect(r).toContain("不限（仅时长兜底）");
		expect(readSubagentConfig(cfg()).maxTurns).toBe(-1);
		const raw = readFileSync(join(dir!, "modules.d", "tool-subagent.toml"), "utf8"); // m4-8 T4：新家
		expect(raw).toContain("maxTurns = -1"); // 数值键不带引号

		askReply = "250"; // 越值 → 拒
		r = await runSubagentMaxTurnsSetting(choose, ask, cfg());
		expect(r).toContain("不在值域");

		askReply = "120"; // 合法自定义
		r = await runSubagentMaxTurnsSetting(choose, ask, cfg());
		expect(r).toContain("120 轮");
		expect(readSubagentConfig(cfg()).maxTurns).toBe(120);

		// 跟随默认（菜单第一档）= 删键
		const chooseDefault = async (_t: string, items: string[]): Promise<string> => items.find((i) => i.startsWith("跟随默认"))!;
		r = await runSubagentMaxTurnsSetting(chooseDefault, ask, cfg());
		expect(r).toContain("跟随默认（100）——配置键已清除");
		expect(readSubagentConfig(cfg()).maxTurns).toBeUndefined();
	});
});

});
