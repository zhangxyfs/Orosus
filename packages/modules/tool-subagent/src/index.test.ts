import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { providerSlotKey, type Chunk, type StreamFn } from "@orosus/contracts/provider";
import type { CommandUi, ModuleDefinition, SubagentPort, SubagentSpawnRequest } from "@orosus/contracts/module";
import approval from "@orosus/approval";
import toolSubagent, { subagentTools } from "./index.ts";
import type { RoleDirs } from "./roles.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const hermetic = (d: string) => ({ userFile: join(d, "no-user.toml"), projectFile: join(d, "no-proj.toml"), env: {} });
const textChunk = (text: string): Chunk[] => [{ type: "text/delta", text }, { type: "finish", kind: "stop" }];
const spawnCall = (callId: string, argsJson: string): Chunk[] => [
  { type: "toolcall/argumentsDelta", callId, name: "tool-subagent__spawn", argumentsDelta: argsJson },
  { type: "finish", kind: "stop" },
];

/** 单元级 stub port：spawn 收集请求、回固定结论。 */
const stubPort = (over: Partial<SubagentPort> = {}): SubagentPort & { calls: SubagentSpawnRequest[] } => {
  const calls: SubagentSpawnRequest[] = [];
  return {
    calls,
    spawn: async (req) => { calls.push(req); return { id: "aaaa1111", status: "completed", turns: 1, conclusion: "干完了" }; },
    list: () => [],
    stop: () => false,
    ...over,
  };
};

const noLog = (): void => undefined;
const exec = async (t: { resolveExecution(input: unknown): Promise<{ execute(c: { callId: string; signal: AbortSignal; log: unknown }): Promise<{ output: string; isError: boolean }> }> }, input: unknown) =>
  (await t.resolveExecution(input)).execute({ callId: "c", signal: new AbortController().signal, log: noLog as never });

const tmpDirs = (): { dirs: () => RoleDirs; root: string } => {
  const root = mkdtempSync(join(tmpdir(), "orosus-t6-"));
  dir = root;
  const empty = join(root, "none");
  return { root, dirs: () => ({ projectBrand: empty, projectGeneric: empty, userBrand: empty, userGeneric: empty }) };
};

describe("派活工具 T6（模块本体：spawn/tasks/stop + 批量校验 + 工种解析）", () => {
  it("⑬ 单发全流程：主对话模型调 tool-subagent__spawn → 子代理跑完 → 结论进工具结果回主对话", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-t6-"));
    const provider = fakeProvider([
      spawnCall("c1", JSON.stringify({ description: "测试单", prompt: "去干活" })),
      textChunk("子代理结论"),
      textChunk("主对话收尾"),
    ]);
    const providerMod: ModuleDefinition = {
      name: "provider-fake", version: "0.1.0", description: "f", api: 1,
      activate(ctx) { ctx.provide(providerSlotKey("fake"), provider.stream as StreamFn); },
    };
    const h = await createHarness({
      store: new InMemorySessionStore(),
      sessionsDir: join(dir, "sessions"),
      diagDir: dir,
      spillDir: join(dir, "spill"),
      cwd: dir, // 工种目录根 = tmp（密封——不读真实 ~/.orosus）
      modules: [providerMod, toolSubagent],
      config: { ...hermetic(dir), cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("派活");
    const events = await h.history();
    const toolResult = events.find((e) => e.type === "tool/result") as unknown as { output: string; isError: boolean } | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect(toolResult!.output).toContain("子代理完成（1/1）");
    expect(toolResult!.output).toContain("子代理结论");
    expect(toolResult!.output).toMatch(/[0-9a-f]{8} · 完成/);
    const final = events.filter((e) => e.type === "assistant/message").at(-1) as unknown as { content: { kind: string; text: string }[] };
    expect(final.content.some((p) => p.text.includes("主对话收尾"))).toBe(true);
    await h.close();
  });

  it("⑭ 批量三校验与展开：items 按条目展开并行派单；缺 {{item}} / 条目重复 / 仅 1 条各自带内报错", async () => {
    const { dirs } = tmpDirs();
    const port = stubPort();
    const [spawnTool] = subagentTools(port, dirs);
    expect(spawnTool!.description).toContain("自动送回"); // 反轮询引导（2026-09-27 拍板）
    expect(spawnTool!.description).toContain("不要轮询");
    expect(spawnTool!.description).toContain("写闸"); // 2026-10-01 实机：Bash 型后台子代理持整仓闸时主对话 Bash 被拦——指引并行走只读工具
    const out = await exec(spawnTool!, { description: "批量总结", prompt: "总结 {{item}} 文件", items: ["甲", "乙"] });
    expect(out.isError).toBe(false);
    expect(port.calls.length).toBe(2);
    expect(port.calls[0]!.prompt).toBe("总结 甲 文件");
    expect(port.calls[1]!.prompt).toBe("总结 乙 文件");
    expect(port.calls[0]!.label).toBe("批量总结：甲");
    expect(out.output).toContain("子代理完成（2/2）");

    expect((await exec(spawnTool!, { description: "x", prompt: "没有占位符", items: ["a", "b"] })).output).toContain("{{item}}");
    expect((await exec(spawnTool!, { description: "x", prompt: "做 {{item}}", items: ["a", "a"] })).output).toContain("互异");
    // 截断收尾标注（双保险丝批）：撞限/超时不失败，标注进结果报告供父代理拆任务
    const truncated = await exec(spawnTool!, { description: "x", prompt: "p" });
    void truncated;
    expect((await exec(spawnTool!, { description: "x", prompt: "做 {{item}}", items: ["a"] })).output).toContain("至少 2 条");
  });

  it("⑭b MV-07 回归钉：description 上限 60 字符落进 schema（原仅 describe 文案承诺，超限静默通过撑长显示行）", async () => {
    const { dirs } = tmpDirs();
    const port = stubPort();
    const [spawnTool] = subagentTools(port, dirs);
    expect(spawnTool!.parameters.safeParse({ description: "x".repeat(60), prompt: "p" }).success).toBe(true); // 恰好 60 在线内
    const over = spawnTool!.parameters.safeParse({ description: "x".repeat(61), prompt: "p" });
    expect(over.success).toBe(false); // registry safeParse 门带内拒
    if (!over.success) expect(over.error.issues.some((i) => i.message.includes("60 字符"))).toBe(true);
    expect(port.calls.length).toBe(0); // 未过门不派单
  });

  it("⑮ 工种解析三路：未知名报错带可用清单；文件工种按白名单/writePaths 生效；spawn 的 writePaths 压过工种预声明", async () => {
    const root = mkdtempSync(join(tmpdir(), "orosus-t6-"));
    dir = root;
    mkdirSync(join(root, "pb"), { recursive: true });
    writeFileSync(join(root, "pb", "myrole.md"), '---\nname: myrole\ndescription: 自定义\ntools:\n  - tool-fs__read\nwritePaths:\n  - docs/\n---\n自定义正文', "utf8");
    const dirs = (): RoleDirs => ({ projectBrand: join(root, "pb"), projectGeneric: join(root, "n"), userBrand: join(root, "n"), userGeneric: join(root, "n") });
    const port = stubPort();
    const [spawnTool] = subagentTools(port, dirs);

    const bad = await exec(spawnTool!, { description: "x", prompt: "p", role: "nope" });
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("未知工种 \"nope\"");
    expect(bad.output).toContain("myrole");
    expect(bad.output).toContain("research");

    await exec(spawnTool!, { description: "x", prompt: "p", role: "myrole" });
    expect(port.calls.at(-1)!.allowedTools).toEqual(["tool-fs__read"]);
    expect(port.calls.at(-1)!.writePaths).toEqual(["docs/"]);
    expect(port.calls.at(-1)!.rolePrompt).toBe("自定义正文");

    await exec(spawnTool!, { description: "x", prompt: "p", role: "myrole", writePaths: ["src/"] });
    expect(port.calls.at(-1)!.writePaths).toEqual(["src/"]); // spawn 显式给的压过工种预声明

    await exec(spawnTool!, { description: "x", prompt: "p" });
    expect(port.calls.at(-1)!.roleName).toBe("general"); // 缺省通用工种
    expect(port.calls.at(-1)!.allowedTools).toBeUndefined();
  });

  it("⑯ 免审批（决策 16）：派活工具无括号规则 + 空访问声明——主对话 ask-risky 下零弹窗直通", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-t6-"));
    const provider = fakeProvider([
      spawnCall("c1", JSON.stringify({ description: "免审批", prompt: "干活" })),
      textChunk("子代理结论"),
      textChunk("收尾"),
    ]);
    const uiCalls: string[] = [];
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应 ask"); },
      askSecret: async () => { throw new Error("不应 askSecret"); },
      confirm: async () => { throw new Error("不应 confirm"); },
      choose: async (_t, items) => { uiCalls.push(items.join("|")); return "批准一次"; },
    };
    const providerMod: ModuleDefinition = {
      name: "provider-fake", version: "0.1.0", description: "f", api: 1,
      activate(ctx) { ctx.provide(providerSlotKey("fake"), provider.stream as StreamFn); },
    };
    const h = await createHarness({
      store: new InMemorySessionStore(),
      sessionsDir: join(dir, "sessions"),
      diagDir: dir,
      spillDir: join(dir, "spill"),
      cwd: dir,
      commandUi: ui,
      modules: [approval, providerMod, toolSubagent],
      config: { ...hermetic(dir), cliOverrides: { model: "fake/m" } }, // approval 缺省 ask-risky
    });
    await h.prompt("派活");
    expect(uiCalls).toEqual([]); // 派活工具免审批（子代理内部工具才走关卡——⑦ 已验）
    const toolResult = (await h.history()).find((e) => e.type === "tool/result") as unknown as { isError: boolean };
    expect(toolResult.isError).toBe(false);
    await h.close();
  });

  it("⑰ tasks/stop 管理工具：列表含父-孙亲缘格式与等审批标注；stop 两态文案", async () => {
    const { dirs } = tmpDirs();
    const port = stubPort({
      list: () => [
        { id: "a3f9c2e1", depth: 1, label: "修复登录页", status: "running", background: false, turns: 3, enqueuedAt: "t" },
        { id: "b7d2f0a3", depth: 2, parentId: "a3f9c2e1", label: "跑测试", status: "running", background: false, turns: 1, enqueuedAt: "t", pendingApproval: { callId: "c", tool: "boom__run", reason: "subprocess" } },
      ],
      stop: (id) => id === "a3f9c2e1",
    });
    const [, tasksTool, stopTool] = subagentTools(port, dirs);
    const list = await exec(tasksTool!, {});
    expect(list.output).toContain("a3f9c2e1 - b7d2f0a3"); // 亲缘格式（决策 21）
    expect(list.output).toContain("等审批");
    const stopped = await exec(stopTool!, { id: "a3f9c2e1" });
    expect(stopped.isError).toBe(false);
    expect(stopped.output).toContain("已停止");
    const unknown = await exec(stopTool!, { id: "deadbeef" });
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain("无此编号");
    const emptyPort = stubPort();
    const [, tasks2] = subagentTools(emptyPort, dirs);
    expect((await exec(tasks2!, {})).output).toContain("暂无在册子代理");
  });

  it("⑱ 前后台判据句 + 后台三禁 + 后台返回行教育（m4-6 T1）", async () => {
    const { dirs } = tmpDirs();
    const port = stubPort();
    const [spawnTool] = subagentTools(port, dirs);
    // 判据句（kimi 定式）+ 三禁（qwen 收窄到我们机制：禁猜/禁替身/禁轮询）
    expect(spawnTool!.description).toContain("前台");
    expect(spawnTool!.description).toContain("另派");
    expect(spawnTool!.description).toContain("编造");
    // 后台单子：返回行带教育句（ZCode 定式——教模型的话写在返回值里，出现在刚发起后台的那一轮）
    const bgPort = stubPort({ spawn: async (req) => { bgPort.calls.push(req); return { id: "dddd4444" }; } });
    const [bgTool] = subagentTools(bgPort, dirs);
    const out = await exec(bgTool!, { description: "跑批", prompt: "整理笔记", background: true });
    expect(out.isError).toBe(false);
    expect(bgPort.calls[0]!.background).toBe(true);
    expect(out.output).toContain("后台已入册");
    expect(out.output).toContain("去做别的独立工作");
    expect(out.output).toContain("重派替身");
  });
});
