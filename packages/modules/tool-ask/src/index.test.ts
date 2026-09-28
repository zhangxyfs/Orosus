import { describe, it, expect, afterEach } from "vitest";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";
import type { CommandUi } from "@orosus/contracts/module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import toolAsk, { askUserTool } from "./index.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

// 单元直驱：工厂注入假 ui
const noLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const mkUi = (over: Partial<Pick<CommandUi, "ask" | "choose">> = {}): Pick<CommandUi, "ask" | "choose"> => ({
  ask: async (q) => `回答:${q}`,
  choose: async (_q, items) => items[0]!,
  ...over,
});
const execAsk = async (ui: Pick<CommandUi, "ask" | "choose">, input: Record<string, unknown>) => {
  const tool = askUserTool(ui);
  const plan = await tool.resolveExecution(input);
  return await plan.execute({ callId: "c1", signal: new AbortController().signal, log: noLog });
};

describe("tool-ask 单元（M4-2 T8/B16）", () => {
  it("① 单问带选项 → choose 被调 → 返回所选", async () => {
    const chooseCalls: string[] = [];
    const r = await execAsk(mkUi({ choose: async (q, items) => { chooseCalls.push(q); return items[1]!; } }),
      { questions: [{ text: "选哪个", options: ["A", "B", "C"] }] });
    expect(chooseCalls).toContain("选哪个");
    expect(r.isError).toBe(false);
    expect(r.output).toContain("B");
  });

  it("② 多问按序（1 choose + 1 ask）→ 各返回", async () => {
    const r = await execAsk(mkUi({ choose: async () => "选项A", ask: async (q) => `文本回答:${q}` }),
      { questions: [{ text: "选", options: ["选项A", "选项B"] }, { text: "自由输入" }] });
    expect(r.output).toContain("选项A");
    expect(r.output).toContain("文本回答:自由输入");
  });

  it("③ 无头 ui（choose 抛错）→ isError 带内返回 Reasonix 回退文案", async () => {
    const r = await execAsk(mkUi({
      choose: async () => { throw new Error("无交互环境"); },
      ask: async () => { throw new Error("无交互环境"); },
    }), { questions: [{ text: "选", options: ["A", "B"] }] });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("无交互用户");
    expect(r.output).toContain("最佳判断");
  });

  // MB-08（2026-09-28 code review）回归钉：取消 ≠ 无头——Esc 抛「已取消（Esc）」（D35/apps-cli 钉死文案），
  // 与 description「Stop and wait」对齐；catch-all 吞取消再教模型「继续+替用户选」的自相矛盾不复存在
  it("③b MB-08 choose 中 Esc 取消 → 「停下等指示」文案，不再误报无交互用户", async () => {
    const r = await execAsk(mkUi({
      choose: async () => { throw new Error("已取消（Esc）"); },
    }), { questions: [{ text: "选", options: ["A", "B"] }] });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("用户取消了本次提问");
    expect(r.output).toContain("停下等用户");
    expect(r.output).not.toContain("无交互用户"); // 旧实现：取消也被吞成「无交互用户…继续」
  });

  it("③c MB-08 ask 自由输入路径的 Esc 同分流；非取消异常仍走无头回退", async () => {
    const cancelled = await execAsk(mkUi({ ask: async () => { throw new Error("已取消（Esc）"); } }),
      { questions: [{ text: "自由输入" }] });
    expect(cancelled.output).toContain("用户取消了本次提问");
    const other = await execAsk(mkUi({ ask: async () => { throw new Error("readline 崩了"); } }),
      { questions: [{ text: "自由输入" }] });
    expect(other.output).toContain("无交互用户"); // 真异常/无头 → 保留 Reasonix 回退语义
  });
});

// 集成：模块装配 + commandUi 注入 + 脚本驱动工具回合（T7 同款两轮脚本）
describe("tool-ask 模块集成（M4-2 T8/B16）", () => {
  it("④ 脚本驱动 → 注入的 commandUi.choose 被调 → 第二轮文本落会话", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-ask-"));
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "tool-ask__ask_user",
          argumentsDelta: JSON.stringify({ questions: [{ text: "选方案", options: ["A（简单）", "B（灵活）"] }] }) },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "已收到选择" }, { type: "finish", kind: "stop" }],
    ];
    const chosen: string[] = [];
    const ui: CommandUi = {
      ask: async (q) => q, askSecret: async () => "", confirm: async () => true,
      choose: async (q, items) => { chosen.push(q); return items[1]!; },
    };
    const mem = new InMemorySessionStore();
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"), commandUi: ui,
      modules: [toolAsk, fakeProviderModule("fake", script)],
      config: { userFile: join(dir, "n.toml"), projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("问我要哪个方案");
    await h.close();
    expect(chosen).toContain("选方案");
    const all = await mem.all();
    expect(all.filter((e) => e.type === "assistant/message").map((e) => JSON.stringify(e)).join("\n")).toContain("已收到选择");
    // 工具结果把用户所选回传模型（B（灵活））
    expect(all.some((e) => e.type === "tool/result" && e.callId === "c1" && String(e.output).includes("B（灵活）"))).toBe(true);
  });
});
