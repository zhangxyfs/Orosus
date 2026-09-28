import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore, scanBucketSessions } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { providerSlotKey, type Chunk, type StreamFn } from "@orosus/contracts/provider";
import { Access, defineTool } from "@orosus/contracts/tool";
import toolFs from "@orosus/tool-fs";
import type { CommandUi, ModuleDefinition, SubagentOutcome, SubagentPort } from "@orosus/contracts/module";
import approval from "@orosus/approval";
import toolSubagent from "@orosus/tool-subagent";

/**
 * 端到端十三场景（M4.5 T15）：主/子/孙三套剧本经真模块链（模型 → tool-subagent__spawn → 内核 runner）。
 * 双槽剧本分流（确定性关键）：主对话走 fake、子代理钉 fake2（[tool-subagent] model = 三来源之首）——
 * 后台单子的请求与主轮续行不共享 fake 流抢序。
 */

let dir: string | undefined;      // 最近一次 setup 的目录（测试体内的路径引用取它）
const dirs: string[] = [];        // 本用例建过的全部目录（s4/s14 多次 setup、s12a 手建、s13 的 root）——统一清，不再只清最后一个
let savedCwd: string | undefined;
let cur: Setup["h"] | undefined;  // 当前活跃 harness——断言中途失败时 afterEach 兜底先 close 再删目录（close 幂等）
afterEach(async () => {
  await cur?.close();
  cur = undefined;
  if (savedCwd !== undefined) process.chdir(savedCwd); // 先切回原 cwd 再删目录（win32 上删不掉进程 cwd）
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  dir = undefined;
});

const text = (t: string): Chunk[] => [{ type: "text/delta", text: t }, { type: "finish", kind: "stop" }];
const call = (callId: string, name: string, args: string): Chunk[] => [
  { type: "toolcall/argumentsDelta", callId, name, argumentsDelta: args },
  { type: "finish", kind: "stop" },
];
const spawnCall = (callId: string, args: Record<string, unknown>): Chunk[] =>
  call(callId, "tool-subagent__spawn", JSON.stringify(args));
const waitUntil = async (cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!await cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
};

interface Setup {
  h: Awaited<ReturnType<typeof createHarness>>;
  port: SubagentPort;
  writes: Map<string, string>;
  gate: { active(): number; started(): Promise<void> };
  bashCommands: string[];
}

/** [tool-subagent] model 注入：已有节则节内插、没有则前置新节（避免重复节头炸 TOML）。 */
const tomlWithAgentModel = (extra: string): string => {
  if (extra.includes("[tool-subagent]")) return extra.replace("[tool-subagent]", '[tool-subagent]\nmodel = "fake2/agent-m"');
  return '[tool-subagent]\nmodel = "fake2/agent-m"\n\n' + extra;
};

const setup = async (mainScript: Chunk[][], agentScript: Chunk[][], opts: { approval?: boolean; ui?: CommandUi; configToml?: string; extraModules?: ModuleDefinition[] } = {}): Promise<Setup> => {
  dir = mkdtempSync(join(tmpdir(), "orosus-e2e-"));
  dirs.push(dir); // 同一用例多次 setup（s4/s14）的目录全登记——afterEach 统一清
  writeFileSync(join(dir, "user.toml"), tomlWithAgentModel(opts.configToml ?? ""), "utf8");
  let port: SubagentPort | undefined;
  const writes = new Map<string, string>();
  const bashCommands: string[] = [];
  let gateActive = 0;
  let notifyStart!: () => void;
  const startedP = new Promise<void>((r) => { notifyStart = r; });
  let startedOnce = false;
  const gate = { active: () => gateActive, started: () => startedP };
  const provider = fakeProvider(mainScript);
  const agentProvider = fakeProvider(agentScript);
  const mk = (name: string, def: Partial<ModuleDefinition>): ModuleDefinition => ({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...def }) as ModuleDefinition;
  const providerMod = mk("provider-fake", {
    activate(ctx) {
      ctx.provide(providerSlotKey("fake"), provider.stream as StreamFn);
      ctx.provide(providerSlotKey("fake2"), agentProvider.stream as StreamFn);
    },
  });
  const consumer = mk("consumer", { mounts: ["subagent"], activate(ctx) { port = ctx.subagent; } });
  const writeMod = mk("w", {
    mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "w__save", description: "写文件", parameters: z.object({ path: z.string(), content: z.string() }),
        resolveExecution: (input) => {
          const { path, content } = input as { path: string; content: string };
          return Promise.resolve({
            accesses: [Access.fsWrite(path)], approvalRule: "w__save",
            execute: () => { writes.set(path, content); return Promise.resolve({ output: `写了 ${path}`, isError: false }); },
          });
        },
      }));
    },
  });
  const gateMod = mk("gate", {
    mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "gate__hold", description: "挂起", parameters: z.object({}),
        resolveExecution: () => Promise.resolve({
          accesses: [], approvalRule: "gate__hold",
          execute: (tc) => new Promise((res) => {
            gateActive++;
            if (!startedOnce) { startedOnce = true; notifyStart(); }
            if (tc.signal.aborted) { gateActive--; res({ output: "[已中止]", isError: true }); return; }
            tc.signal.addEventListener("abort", () => { gateActive--; res({ output: "[已中止]", isError: true }); }, { once: true });
          }),
        }),
      }));
    },
  });
  const bashMod = mk("tool-shell", {
    mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "tool-shell__bash", description: "跑命令", parameters: z.object({ command: z.string() }),
        resolveExecution: (input) => {
          const { command } = input as { command: string };
          return Promise.resolve({
            accesses: [Access.subprocess()], approvalRule: "tool-shell__bash",
            execute: () => { bashCommands.push(command); return Promise.resolve({ output: `ran ${command}`, isError: false }); },
          });
        },
      }));
    },
  });
  const h = await createHarness({
    store: new InMemorySessionStore(),
    sessionsDir: join(dir, "sessions"),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    cwd: dir,
    ...(opts.ui !== undefined ? { commandUi: opts.ui } : {}),
    modules: [providerMod, consumer, toolSubagent, writeMod, gateMod, bashMod, toolFs, ...(opts.approval === true ? [approval] : []), ...(opts.extraModules ?? [])],
    config: { userFile: join(dir, "user.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
  });
  cur = h; // TS-13：登记当前 harness——测试体末尾的显式 close 照旧，失败路径由 afterEach 兜底
  return { h, port: port!, writes, gate, bashCommands };
};

const histOf = async (h: Setup["h"]): Promise<{ type: string; [k: string]: unknown }[]> =>
  (await h.history()) as unknown as { type: string; [k: string]: unknown }[];
const toolResults = async (h: Setup["h"]): Promise<{ output: string; isError: boolean }[]> =>
  (await histOf(h)).filter((e) => e.type === "tool/result") as unknown as { output: string; isError: boolean }[];
const firstSpawnResult = async (h: Setup["h"]): Promise<string> => (await toolResults(h))[0]!.output;

describe("端到端十三场景 T15", () => {
  it("s1 单发全流程：主对话调 spawn → 子代理跑完 → 结论进工具结果回主对话，花名册 completed", async () => {
    const s = await setup(
      [spawnCall("c1", { description: "调研竞品", prompt: "去调研" }), text("主对话收尾")],
      [text("竞品功能结论：三档导入")],
    );
    await s.h.prompt("帮我调研竞品");
    const out = await firstSpawnResult(s.h);
    expect(out).toContain("子代理完成（1/1）");
    expect(out).toContain("竞品功能结论：三档导入");
    await waitUntil(() => s.h.subagents().length === 1 && s.h.subagents()[0]!.status === "completed");
    expect(s.h.subagents()[0]!.label).toBe("调研竞品");
    await s.h.close();
  }, 15000);

  it("s2 批量排队：10 条清单并发上限 8、全部完成在册", async () => {
    const s = await setup(
      [spawnCall("c0", { description: "批量", prompt: "秒完 {{item}}", items: Array.from({ length: 10 }, (_, i) => `任务${i}`), background: true }), text("主对话收尾")],
      [text("秒完")],
    );
    await s.h.prompt("跑批量");
    await waitUntil(() => s.h.subagents().length === 10 && s.h.subagents().every((a) => a.status === "completed"), 8000);
    expect(s.h.subagents().length).toBe(10);
    await s.h.close();
  }, 20000);

  it("s3 审批拒绝后收尾：子代理工具被用户拒绝 → 带内 denied → 模型照常收尾交结论", async () => {
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应 ask"); },
      askSecret: async () => { throw new Error("不应 askSecret"); },
      confirm: async () => { throw new Error("不应 confirm"); },
      choose: async (_t, items) => (items.includes("拒绝") ? "拒绝" : "批准一次"),
    };
    const s = await setup(
      [spawnCall("c1", { description: "跑构建", prompt: "跑" }), text("主对话收尾")],
      [call("a1", "tool-shell__bash", JSON.stringify({ command: "npm run build" })), text("构建被拒了，如实汇报")],
      { approval: true, ui },
    );
    await s.h.prompt("派个构建");
    expect(await firstSpawnResult(s.h)).toContain("子代理完成（1/1）");
    expect(s.bashCommands).toEqual([]); // 被拒未执行
    await s.h.close();
  }, 15000);

  it("s4 审批模式三路 e2e：手动 auto 零弹窗 / 跟随主 never→auto / 默认 Ask 挂起后停止自动回绝", async () => {
    const uiCalls: string[] = [];
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应 ask"); },
      askSecret: async () => { throw new Error("不应 askSecret"); },
      confirm: async () => { throw new Error("不应 confirm"); },
      choose: async (_t, items) => { uiCalls.push(items.join("|")); return "批准一次"; },
    };
    const main = [spawnCall("c1", { description: "跑命令", prompt: "跑", background: true }), text("主对话收尾")];
    const agent = [call("a1", "tool-shell__bash", JSON.stringify({ command: "echo hi" })), text("跑完了")];

    const sA = await setup(main, agent, { approval: true, ui, configToml: '[tool-subagent]\napprovalMode = "auto"\n' });
    await sA.h.prompt("派");
    await waitUntil(() => sA.h.subagents().length === 1 && sA.h.subagents()[0]!.status === "completed");
    expect(uiCalls).toEqual([]);
    expect(sA.bashCommands).toEqual(["echo hi"]);
    await sA.h.close();

    const sB = await setup(main, agent, { approval: true, ui, configToml: '[approval]\nmode = "never"\n' });
    await sB.h.prompt("派");
    await waitUntil(() => sB.h.subagents().length === 1 && sB.h.subagents()[0]!.status === "completed");
    expect(uiCalls).toEqual([]);
    await sB.h.close();

    const sC = await setup(main, agent, { approval: true, ui });
    await sC.h.prompt("派");
    await waitUntil(() => sC.h.subagents()[0]?.pendingApproval !== undefined);
    const id = sC.h.subagents()[0]!.id;
    sC.h.stopAllSubagents();
    await waitUntil(() => sC.h.subagents().find((a) => a.id === id)?.status === "failed");
    expect(sC.bashCommands).toEqual([]);
    await sC.h.close();
  }, 25000);

  it("s5 前台取消跟 Esc：主 turn 取消 → 前台子代理同步被打断（failed）", async () => {
    const s = await setup(
      [spawnCall("c1", { description: "前台挂起", prompt: "等" })],
      [call("a1", "gate__hold", "{}")],
    );
    const p = s.h.prompt("派前台");
    await s.gate.started();
    s.h.cancel();
    await p;
    await waitUntil(() => s.h.subagents()[0]?.status === "failed");
    expect(s.gate.active()).toBe(0);
    await s.h.close();
  }, 15000);

  it("s6 带历史开局 e2e：模型传 forkFrom:true → 子代理承接主对话前半段（own 文件记分叉点）", async () => {
    const s = await setup(
      [text("上面聊过甲乙丙"), spawnCall("c1", { description: "照着做", prompt: "照上面聊的做 X", forkFrom: true }), text("主对话收尾")],
      [text("子代结论")],
    );
    await s.h.prompt("先说点背景");
    await s.h.prompt("派个照着做的");
    expect(await firstSpawnResult(s.h)).toContain("子代结论");
    const agentSid = s.h.subagents()[0]!.id;
    const raw = readFileSync(join(dir!, "sessions", s.h.sessionId, "agents", `agents_${agentSid}`, "agents", "session.jsonl"), "utf8");
    expect(raw).toContain("session/fork");
    await s.h.close();
  }, 15000);

  it("s7 后台 + 列表 + 停止 e2e：工具回执行编号 → 花名册在列 → stop 停成 failed", async () => {
    const s = await setup(
      [spawnCall("c1", { description: "后台挂起", prompt: "等", background: true }), text("主对话收尾")],
      [call("a1", "gate__hold", "{}")],
    );
    await s.h.prompt("派后台");
    expect(await firstSpawnResult(s.h)).toMatch(/后台已入册（1 个，跑完自动送回）：[0-9a-f]{8}/);
    await waitUntil(() => s.h.subagents()[0]?.status === "running");
    const id = s.h.subagents()[0]!.id;
    expect(s.port.stop(id)).toBe(true);
    await waitUntil(() => s.h.subagents().find((a) => a.id === id)?.status === "failed");
    await s.h.close();
  }, 15000);

  it("s8 送结论 e2e：闲时后台结论自动进对话（[非用户输入] 头 + sourceModule 标记）", async () => {
    const s = await setup(
      [spawnCall("c1", { description: "后台速完", prompt: "干", background: true }), text("主对话收尾"), text("收到结论")],
      [text("后台的结论甲")],
    );
    await s.h.prompt("派后台速完");
    await waitUntil(async () => (await histOf(s.h)).some((e) => e.type === "agent/steering-message" && JSON.stringify(e).includes("后台速完")), 8000);
    const line = (await histOf(s.h)).filter((e) => e.type === "agent/steering-message") // m4-6 T7 后首条 steering 是日期系统行——送回行按内容找
      .flatMap((e) => ((e as { messages?: { text?: string; sourceModule?: string }[] }).messages ?? []))
      .find((m) => (m.text ?? "").includes("后台速完"));
    expect(line!.text).toContain("[非用户输入] 后台子代理 后台速完 完成：后台的结论甲");
    expect(line!.sourceModule).toBe("tool-subagent");
    await s.h.close();
  }, 15000);

  it("s9a 到顶 e2e：子代理经真 spawn 工具派孙代理 → 孙入花名册带父编号（孙面剥净已在 T2⑥ 钉）", async () => {
    const s = await setup(
      [spawnCall("c1", { description: "父代", prompt: "再派孙代" }), text("主对话收尾")],
      [spawnCall("g1", { description: "孙代任务", prompt: "孙代干活", role: "research" }), text("孙代结论"), text("父代结论")],
    );
    await s.h.prompt("派父代");
    const roster = s.h.subagents();
    expect(roster.length).toBe(2);
    const grand = roster.find((a) => a.depth === 2)!;
    expect(grand.parentId).toBeDefined();
    expect(roster.find((a) => a.depth === 1)!.id).toBe(grand.parentId);
    expect(await firstSpawnResult(s.h)).toContain("父代结论");
    await s.h.close();
  }, 15000);

  it("s9b 嵌套满载快败 e2e：并发位占满 → 模型链派孙立即失败（不排队、父不被拖死）", async () => {
    // 占位走 port 层直填（后台挂起单——T8 ㉕ 同形态，比模型链批量更不赌时序）；父代仍走真 spawn 工具链
    const s = await setup(
      [
        spawnCall("p0", { description: "父代", prompt: "派孙" }),
        text("主对话收尾"),
      ],
      [
        ...Array.from({ length: 7 }, (_, i) => call(`g${i}`, "gate__hold", "{}")), // 7 个占位各吃一个（挂住）
        spawnCall("s0", { description: "孙代", prompt: "孙活" }),                  // 父代派孙 → 并发位满 → 快败（带内）
        text("孙代满载失败了，汇报"),                                               // 父代收尾
      ],
    );
    const holders: string[] = [];
    for (let i = 0; i < 7; i++) { // 7 个占位——第 8 位留给父代（父排队的语义是另一回事，这里测孙快败）
      holders.push(((await s.port.spawn({ label: `占位${i}`, prompt: "等", background: true, allowedTools: ["gate__hold"] })) as { id: string }).id);
    }
    await waitUntil(() => s.h.subagents().filter((a) => a.status === "running").length === 7, 8000);
    await s.h.prompt("派会派孙的");
    const out = await firstSpawnResult(s.h);
    expect(out).toContain("满载");
    const grand = s.h.subagents().find((a) => a.depth === 2)!;
    expect(grand.status).toBe("failed"); // 快败入册（spawn 先入册、并发位后快败）
    expect(grand.error).toContain("满载");
    expect(s.h.subagents().filter((a) => a.depth === 1).at(-1)!.status).toBe("completed"); // 父不被拖死（末位 = 父；占位还在挂）
    await s.h.close();
  }, 20000);

  it("s10 树扫描排除 e2e：跑过子/孙代理的真实 sessions 目录扫不出独立会话", async () => {
    const s = await setup(
      [spawnCall("c1", { description: "带孙", prompt: "再派孙" }), text("主对话收尾")],
      [spawnCall("g1", { description: "孙", prompt: "孙活", role: "research" }), text("孙结论"), text("父结论")],
    );
    await s.h.prompt("派");
    await waitUntil(() => s.h.subagents().every((a) => a.status === "completed"));
    const found = scanBucketSessions(join(dir!, "sessions"));
    expect(found.filter((f) => f.id.startsWith("agents_"))).toEqual([]); // 子/孙目录绝不当独立会话
    await s.h.close();
  }, 15000);

  it("s11 双击 Esc 全停 e2e（harness 面）：后台在跑 + 挂起审批 → stopAllSubagents 全收场、审批回绝", async () => {
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应"); }, askSecret: async () => { throw new Error("不应"); },
      confirm: async () => { throw new Error("不应"); }, choose: async () => "批准一次",
    };
    const s = await setup(
      [spawnCall("c1", { description: "挂审批", prompt: "跑", background: true }), spawnCall("c2", { description: "挂工具", prompt: "等", background: true }), text("主对话收尾")],
      [call("a1", "tool-shell__bash", JSON.stringify({ command: "echo x" })), call("a2", "gate__hold", "{}")],
      { approval: true, ui },
    );
    await s.h.prompt("派两个后台");
    await waitUntil(() => s.h.subagents().some((a) => a.pendingApproval !== undefined));
    s.h.stopAllSubagents();
    await waitUntil(() => s.h.subagents().every((a) => a.status === "failed" || a.status === "completed"), 8000);
    expect(s.bashCommands).toEqual([]);
    expect(s.gate.active()).toBe(0);
    await s.h.close();
  }, 20000);

  it("s12a 报备重叠串行 e2e：两个写 docs/ 的子代理先后落笔（无交错）+ 闸随结束释放", async () => {
    const order: string[] = [];
    dir = mkdtempSync(join(tmpdir(), "orosus-e2e-"));
    dirs.push(dir); // 手建目录同样登记——afterEach 统一清
    writeFileSync(join(dir, "user.toml"), tomlWithAgentModel(""), "utf8");
    const main = [
      spawnCall("c1", { description: "写手甲", prompt: "写A", background: true, writePaths: ["docs/"] }),
      spawnCall("c2", { description: "写手乙", prompt: "写B", background: true, writePaths: ["docs/"] }),
      text("主对话收尾"),
    ];
    // 甲乙共用 fake2 流：写A → 甲完；乙（排队等闸）→ 写B → 乙完
    const agentScript: Chunk[][] = [
      call("a1", "w__write", JSON.stringify({ path: "docs/a.txt", content: "A" })),
      text("甲完"),
      call("b1", "w__write", JSON.stringify({ path: "docs/b.txt", content: "B" })),
      text("乙完"),
    ];
    const providerMod: ModuleDefinition = {
      name: "provider-fake", version: "0.1.0", description: "f", api: 1,
      activate(ctx) {
        ctx.provide(providerSlotKey("fake"), fakeProvider(main).stream as StreamFn);
        ctx.provide(providerSlotKey("fake2"), fakeProvider(agentScript).stream as StreamFn);
      },
    };
    const consumer: ModuleDefinition = { name: "consumer", version: "0.1.0", description: "c", api: 1, mounts: ["subagent"], activate() {} };
    const writeSlow: ModuleDefinition = {
      name: "w", version: "0.1.0", description: "写", api: 1, mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "w__write", description: "写", parameters: z.object({ path: z.string(), content: z.string() }),
          resolveExecution: (input) => {
            const { path, content } = input as { path: string; content: string };
            return Promise.resolve({
              accesses: [Access.fsWrite(path)], approvalRule: "w__write",
              execute: async () => {
                order.push(`begin:${content}`);
                await new Promise((r) => setTimeout(r, 60)); // 落笔耗时——若并行会交错
                order.push(`end:${content}`);
                return { output: "ok", isError: false };
              },
            });
          },
        }));
      },
    };
    const h = await createHarness({
      store: new InMemorySessionStore(), sessionsDir: join(dir, "sessions"), diagDir: dir, spillDir: join(dir, "spill"), cwd: dir,
      modules: [providerMod, consumer, toolSubagent, writeSlow],
      config: { userFile: join(dir, "user.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    cur = h; // 手建 harness 同样登记——afterEach 兜底 close
    await h.prompt("派两个写手");
    await waitUntil(() => h.subagents().length === 2 && h.subagents().every((a) => a.status === "completed"), 8000);
    expect(order).toEqual(["begin:A", "end:A", "begin:B", "end:B"]); // 串行：A 完整落笔后 B 才开始
    await h.close();
  }, 20000);

  it("s12b 同血缘撞车快败 e2e：父持 docs/ 写闸 → 派撞车前台孙代理 → 孙立即失败（不死锁）", async () => {
    const s = await setup(
      [spawnCall("c1", { description: "父写手", prompt: "父活", writePaths: ["docs/"] }), text("主对话收尾")],
      [spawnCall("g1", { description: "孙写手", prompt: "孙活", writePaths: ["docs/"] }), text("父完")],
    );
    await s.h.prompt("派父写手");
    expect(await firstSpawnResult(s.h)).toContain("父完");
    const grand = s.h.subagents().find((a) => a.depth === 2)!;
    expect(grand.status).toBe("failed"); // 快败入册（spawn 先入册、写闸后快败）
    expect(grand.error).toContain("上级代理"); // 指路文案
    const dad = s.h.subagents().find((a) => a.depth === 1)!;
    expect(dad.status).toBe("completed"); // 父不被拖死
    await s.h.close();
  }, 15000);

  it("s12c 越界回执 e2e：报备 docs/ 的子代理写 docs 外 → 执行期拦 + 回执列入工具结果", async () => {
    const s = await setup(
      [spawnCall("c1", { description: "越界写手", prompt: "写两处", writePaths: ["docs/"] }), text("主对话收尾")],
      [
        call("a1", "w__save", JSON.stringify({ path: "docs/in.txt", content: "I" })),
        call("a2", "w__save", JSON.stringify({ path: "outside.txt", content: "O" })),
        text("写完了"),
      ],
    );
    await s.h.prompt("派越界写手");
    const out = await firstSpawnResult(s.h);
    expect(out).toContain("越界回执");
    expect(out).toContain("outside.txt");
    expect(s.writes.has("docs/in.txt")).toBe(true);
    expect(s.writes.has("outside.txt")).toBe(false);
    await s.h.close();
  }, 15000);

  it("s13 写前比对 e2e（真 tool-fs）：主对话读过 → 子代理改了 → 主对话再写被拦要求重读", async () => {
    savedCwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "orosus-e2e-fs-")); // 注意：setup 会另建并覆写 dir——真文件操作全用 root
    dirs.push(root); // root 也登记——旧写法从不清理，每次运行泄一个含文件的目录（TS-12）
    process.chdir(root); // tool-fs 根 = 进程 cwd（tool-fs 测试同款隔离法）
    writeFileSync(join(root, "shared.txt"), "初版\n");
    const s = await setup(
      [
        call("r1", "tool-fs__read", JSON.stringify({ path: "shared.txt" })),
        text("主读完"),
        call("w1", "tool-fs__write", JSON.stringify({ path: "shared.txt", content: "按旧印象覆盖\n" })),
        text("被拦后汇报"),
      ],
      [call("a1", "gate__hold", "{}"), text("子完")], // 子代理只占位（真改文件由测试直写模拟「别人改了」）
    );
    await s.h.prompt("读一下");
    writeFileSync(join(root, "shared.txt"), "子代理改的\n"); // 读后被别人改
    utimesSync(join(root, "shared.txt"), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000)); // 强推 mtime（读写同毫秒会让守卫漏判——不赌时序）
    await s.h.prompt("现在写");
    const rs = await toolResults(s.h);

    expect(rs.some((r) => r.isError && r.output.includes("读取后被修改过"))).toBe(true);
    expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("子代理改的\n"); // 未被旧印象覆盖
    await s.h.close();
  }, 20000);

  it("s13b 主对话写预约 e2e：子代理持 src/ 报备在跑 → 主对话写 src/ 立即失败重试文案", async () => {
    const s = await setup(
      [
        spawnCall("c1", { description: "占闸写手", prompt: "等", background: true, writePaths: ["src/"] }),
        text("主对话收尾"),
        call("m1", "w__save", JSON.stringify({ path: "src/main.ts", content: "X" })),
        text("撞车了稍后重试"),
      ],
      [call("a1", "gate__hold", "{}")],
    );
    await s.h.prompt("派占闸写手");
    await s.gate.started();
    await waitUntil(() => s.h.subagents().some((a) => a.status === "running"));
    await s.h.prompt("我来写 src");
    const rs = await toolResults(s.h);
    expect(rs.some((r) => r.isError && r.output.includes("写报备撞车"))).toBe(true);
    expect(s.writes.has("src/main.ts")).toBe(false);
    await s.h.close();
  }, 20000);

  it("s14 CX-06 spill 文件名消毒：恶意 callId（穿越串/win32 非法字符/同 id 复用）不逃出子代理 spillDir，全文落盘可读", async () => {
    const big = "溢".repeat(33000); // > OUTPUT_LIMIT（字节按 length 近似口径）
    const bigMod: ModuleDefinition = {
      name: "big", version: "0.1.0", description: "大输出", api: 1, mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "big__out", description: "大", parameters: z.object({}),
          resolveExecution: () => Promise.resolve({
            accesses: [], approvalRule: "big__out",
            execute: () => Promise.resolve({ output: big, isError: false }),
          }),
        }));
      },
    };
    const spillRootOf = (h: Setup["h"], id: string): string => join(dir!, "sessions", h.sessionId, "agents", `agents_${id}`, "spill");
    const spillPathOf = (h: Setup["h"], id: string): string => {
      const raw = readFileSync(join(dir!, "sessions", h.sessionId, "agents", `agents_${id}`, "agents", "session.jsonl"), "utf8");
      const tr = raw.split("\n").filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { type?: string; output?: string }).find((e) => e.type === "tool/result");
      const m = /全文已溢写 (.+?)…/u.exec(tr?.output ?? "");
      expect(m).not.toBeNull(); // 溢写成功（旧实现在此就分叉：非法字符炸盘降级「溢写失败」）
      return m![1]!;
    };
    // A. 穿越串：≥3 个 ".." 的 callId 在旧实现下经 join 归一逃出 spillDir（CX-06 校验备注实测口径）
    const s = await setup([text("主对话收尾")], [call("../../../../../evil", "big__out", "{}"), text("完")], { extraModules: [bigMod] });
    const outA = (await s.port.spawn({ label: "穿越溢写", prompt: "跑" })) as SubagentOutcome;
    expect(outA.status).toBe("completed");
    const pathA = spillPathOf(s.h, outA.id);
    const relA = relative(spillRootOf(s.h, outA.id), pathA);
    expect(relA.startsWith("..")).toBe(false);   // 落在该子代理 spillDir 内（旧实现：spill-../../.. 直接写出到 sessions/ 层）
    expect(isAbsolute(relA)).toBe(false);
    expect(readFileSync(pathA, "utf8")).toBe(big); // 全文完整落盘
    await s.h.close();
    // B. win32 非法字符（:*?"<>|）：旧实现 writeFileSync 抛 → CX-03 后降级丢溢写；消毒后照常落盘（独立 harness——fakeProvider 顺序消费不共享）
    const s2 = await setup([text("主对话收尾")], [call('bad:*?"<>|name', "big__out", "{}"), text("完")], { extraModules: [bigMod] });
    const outB = (await s2.port.spawn({ label: "非法字符溢写", prompt: "跑" })) as SubagentOutcome;
    expect(outB.status).toBe("completed");
    const pathB = spillPathOf(s2.h, outB.id);
    expect(readFileSync(pathB, "utf8")).toBe(big);
    await s2.h.close();
    // C. 同 callId 两次超限：序号防覆写——两份全文都在（旧实现第二次覆写第一次，前文丢失）
    const s3 = await setup([text("主对话收尾")], [call("dup", "big__out", "{}"), call("dup", "big__out", "{}"), text("完")], { extraModules: [bigMod] });
    const outC = (await s3.port.spawn({ label: "复用溢写", prompt: "跑" })) as SubagentOutcome;
    expect(outC.status).toBe("completed");
    const rootC = spillRootOf(s3.h, outC.id);
    const files = readdirSync(rootC).filter((f) => f.endsWith(".txt"));
    expect(files.length).toBe(2); // spill-<序号>-dup.txt × 2——同 callId 不互相覆写
    for (const f of files) expect(readFileSync(join(rootC, f), "utf8")).toBe(big);
    await s3.h.close();
  }, 45000);
});
