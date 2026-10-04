import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import { defineTool } from "@orosus/contracts/tool";
import type { Chunk } from "@orosus/contracts/provider";
import toolSearch, { catalogText, scoreTool, searchMetaTool } from "./index.ts";
import type { ToolInfo } from "@orosus/contracts/tool";

let dir = "";
afterEach(() => { if (dir !== "") rmSync(dir, { recursive: true, force: true }); dir = ""; });
const tmp = () => (dir = mkdtempSync(join(tmpdir(), "orosus-ts-")));
const noLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

const info = (name: string, over: Partial<ToolInfo> = {}): ToolInfo => ({
  name, description: `${name} 的描述`, deferred: true, revealed: false, owner: name.split("__")[0]!, ...over,
});

const mkSeam = (catalog: ToolInfo[]) => {
  const revealedCalls: string[][] = [];
  let enabled = 0;
  const seam = {
    reveal: (names: string[]) => { revealedCalls.push(names); for (const n of names) { const t = catalog.find((x) => x.name === n); if (t !== undefined) t.revealed = true; } },
    list: (opts?: { deferredOnly?: boolean }) => catalog.filter((t) => (opts?.deferredOnly === true ? t.deferred : true)),
    enable: () => { enabled += 1; },
  };
  return { seam, revealedCalls, enabled: () => enabled };
};

const execSearch = async (seam: ReturnType<typeof mkSeam>["seam"], query: string) => {
  const tool = searchMetaTool(seam);
  const plan = await tool.resolveExecution({ query });
  return plan.execute({ callId: "c1", signal: new AbortController().signal, log: noLog });
};

describe("tool-search meta 工具与目录段（M4-3 T4）", () => {
  it("T4-⑥ 打分表：名词 10/MCP 12/子串 5/hint 4/描述 2 + 精确名短路；直选与 +词 必含", async () => {
    const neutral = { description: "深度工具" };
    expect(scoreTool(info("mcp__fs_read", { owner: "mcp", ...neutral }), ["read"])).toBe(12); // 名词命中（MCP 属主 12）
    expect(scoreTool(info("git__log", neutral), ["log"])).toBe(10); // 名词命中（非 MCP 10）
    expect(scoreTool(info("m__reader", neutral), ["read"])).toBe(5); // 名子串（非整词）
    expect(scoreTool(info("m__x", { ...neutral, searchHint: "日志分析" }), ["日志"])).toBe(4); // searchHint
    expect(scoreTool(info("m__x", { description: "处理账单数据" }), ["账单"])).toBe(2); // 描述词
    expect(scoreTool(info("m__x"), ["m__x"])).toBe(1000); // 精确名短路
    // select 直选
    const { seam, revealedCalls } = mkSeam([info("m__a"), info("m__b"), info("m__c")]);
    const r1 = await execSearch(seam, "select:m__a,m__c,m__ghost");
    expect(r1.output).toContain("已加载：m__a");
    expect(r1.output).toContain("已加载：m__c");
    expect(r1.output).toContain("m__ghost");
    expect(revealedCalls[0]!.sort()).toEqual(["m__a", "m__c"]);
    // +词 必含
    const { seam: seam2 } = mkSeam([info("git__log"), info("git__blame"), info("web__fetch")]);
    const r2 = await execSearch(seam2, "+git log");
    expect(r2.output).toContain("git__log");
    expect(r2.output).not.toContain("已加载：web__fetch");
  });

  it("T4-⑦ meta 出货：已加载列表（下一轮起可调用）+ 默认 5 条帽；未命中 ≤3 近似建议；空目录话术", async () => {
    const many = Array.from({ length: 8 }, (_, i) => info(`m__tool${i}`));
    const { seam } = mkSeam(many);
    const r = await execSearch(seam, "tool");
    expect(r.output.match(/已加载：/g)).toHaveLength(5); // 默认 5 条（SW-10）
    expect(r.output).toContain("下一轮起可调用");
    const { seam: seam2 } = mkSeam([info("github__pr"), info("gitlab__mr"), info("web__fetch")]);
    const miss = await execSearch(seam2, "gitxxx");
    expect(miss.output).toContain("未命中");
    const { seam: seam3 } = mkSeam([]);
    const empty = await execSearch(seam3, "x");
    expect(empty.output).toContain("按需目录为空");
  });

  it("T4-⑧+T19② 目录段：hidden 列表（截断描述 80→160 字放宽）+ 空目录空串过滤 + reveal 后条目消失", () => {
    const { seam } = mkSeam([
      info("m__a", { description: "长".repeat(200) }),
      info("m__b"),
    ]);
    const text1 = catalogText(seam);
    expect(text1).toContain("The following 2 tools load on demand");
    expect(text1).toContain("m__a");
    expect(text1).toContain("长".repeat(159)); // 帽内全显（truncate 留 1 列给 …；旧 80 帽会腰斩）
    expect(text1).toContain("…"); // 200 字超帽截断
    expect(text1).not.toContain("长".repeat(161));
    seam.reveal(["m__a"]);
    const text2 = catalogText(seam);
    expect(text2).toContain("The following 1 tools load on demand");
    expect(text2).not.toContain("m__a");
    seam.reveal(["m__b"]);
    expect(catalogText(seam)).toBe(""); // 空串被装配过滤（不占提示词预算）
  });

  it("T4-⑨ 模块开关与 mounts：关态 = 模块整门不启（SW-26 钉）；声明 mounts 未列位即抛", async () => {
    tmp();
    // 关态（2026-09-30 默认翻开后须显式关：[tool-search] enabled = false）：模块不激活——audit 落 discovered、meta 工具不存在
    writeFileSync(join(dir, "n.toml"), "[tool-search]\nenabled = false\n", "utf8");
    const h = await createHarness({
      store: new InMemorySessionStore(),
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [toolSearch, fakeProviderModule("fake", [])],
      config: { userFile: join(dir, "n.toml"), projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    expect(h.graph().audit().find((a) => a.name === "tool-search")?.state).toBe("discovered");
    expect(h.graph().commands.find((c) => c.name === "tool-search__search")).toBeUndefined();
    await h.close();
    // 无配置默认开（2026-09-30 拍板翻转）：meta 工具在场
    const h0 = await createHarness({
      store: new InMemorySessionStore(),
      diagDir: dir, spillDir: join(dir, "spill0"),
      modules: [toolSearch, fakeProviderModule("fake", [])],
      config: { userFile: join(dir, "n0.toml"), projectFile: join(dir, "p0.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    expect(h0.graph().audit().find((a) => a.name === "tool-search")?.state).toBe("active");
    expect(h0.graph().tools.toolInfos().find((t) => t.name === "tool-search__search")).toBeDefined(); // 工具面非命令面
    await h0.close();
    // 开态但 mounts 收紧：声明 mounts 未含 tools.reveal → enable 调用抛错（模块降级非炸穿）
    const tight: ModuleDefinition = defineModule({
      name: "tool-search", version: "0.1.0", description: "x", api: 1,
      mounts: ["tools.list"], // 未列 tools.reveal/contribute:*
      activate(ctx) { ctx.tools.enable(); },
    });
    const userFile = join(dir, "u.toml");
    writeFileSync(userFile, "[tool-search]\nenabled = true\n", "utf8");
    const h2 = await createHarness({
      store: new InMemorySessionStore(),
      diagDir: dir, spillDir: join(dir, "spill2"),
      modules: [tight, fakeProviderModule("fake", [])],
      config: { userFile, projectFile: join(dir, "p2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    expect(h2.graph().audit().find((a) => a.name === "tool-search")?.state).toBe("failed"); // 权限位缺失 → 激活抛错降级
    await h2.close();
  });

  it("T4-⑩ harness 集成：deferred 假工具被藏 → meta 搜出 reveal → 下一轮 specs 可见且可调", async () => {
    tmp();
    const lazy = defineModule({
      name: "lazy", version: "0.1.0", description: "x", api: 1,
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "lazy__deep", description: "深度分析引擎", searchHint: "analyze deep", deferred: true,
          parameters: z.object({}),
          resolveExecution: async () => ({ execute: async () => ({ output: "deep-done", isError: false }) }),
        }));
      },
    });
    const userFile = join(dir, "u.toml");
    writeFileSync(userFile, "[tool-search]\nenabled = true\n", "utf8");
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "tool-search__search",
          argumentsDelta: JSON.stringify({ query: "deep" }) },
        { type: "finish", kind: "toolUse" },
      ],
      [
        { type: "toolcall/argumentsDelta", callId: "c2", name: "lazy__deep", argumentsDelta: "{}" },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "完成" }, { type: "finish", kind: "stop" }],
    ];
    const mem = new InMemorySessionStore();
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [lazy, toolSearch, fakeProviderModule("fake", script)],
      config: { userFile, projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("用深度分析");
    await h.close();
    const all = await mem.all();
    const searchResult = all.find((e) => e.type === "tool/result" && e.callId === "c1");
    expect(String(searchResult && JSON.stringify(searchResult))).toContain("已加载：lazy__deep");
    // reveal 后 lazy__deep 可 plan 执行（c2 成功——未被「按需加载目录」拦截）
    const deepResult = all.find((e) => e.type === "tool/result" && e.callId === "c2");
    expect(String(deepResult && JSON.stringify(deepResult))).toContain("deep-done");
  });
});

describe("T19 三小改（m4-3c）", () => {
  it("① 桥接工具 searchHint「mcp + server 名」参与打分——server 名只经 hint 命中（+4），无 hint 同词 0 分", async () => {
    const { scoreTool } = await import("./index.ts");
    const withHint = { name: "mcp__gh__create_issue", owner: "mcp", description: "创建 issue", searchHint: "mcp github" } as never;
    const noHint = { name: "mcp__gh__create_issue", owner: "mcp", description: "创建 issue" } as never;
    expect(scoreTool(withHint, ["github"])).toBe(4); // 「github」只出现在 hint——搜 server 名能命中（真实增益：工具名常缩写）
    expect(scoreTool(noHint, ["github"])).toBe(0); // 无 hint：名字/描述全不中
    expect(scoreTool(withHint, ["mcp", "github"])).toBeGreaterThan(scoreTool(noHint, ["mcp", "github"])); // 排序增益
  });

  it("② 目录行描述帽 80 → 160（qwen 同值——与 T11③ 共口径）", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
    expect(src).toContain("const DESC_TRUNC = 160;");
    expect(src).not.toContain("const DESC_TRUNC = 80;");
  });
});
