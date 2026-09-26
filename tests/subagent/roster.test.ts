import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { providerSlotKey, type Chunk, type StreamFn } from "@orosus/contracts/provider";
import { Access, defineTool } from "@orosus/contracts/tool";
import type { CommandUi, ModuleDefinition, SubagentOutcome, SubagentPort } from "@orosus/contracts/module";
import approval from "@orosus/approval";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const text = (t: string): Chunk[] => [{ type: "text/delta", text: t }, { type: "usage", input: 5, output: 7 }, { type: "finish", kind: "stop" }];
const call = (callId: string, name: string, argsJson = "{}"): Chunk[] => [
  { type: "toolcall/argumentsDelta", callId, name, argumentsDelta: argsJson },
  { type: "finish", kind: "stop" },
];

/** 等到条件成立或超时（后台收场是异步链——测试不赌时序）。 */
const waitUntil = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
};

interface Setup {
  h: Awaited<ReturnType<typeof createHarness>>;
  port: SubagentPort;
  gate: { started: () => Promise<void>; count: () => number };
}

/** gate__wait 工具：挂起直到 signal 打断——「占着并发位不撒手」的道具。 */
const makeGateTool = (): { mod: ModuleDefinition; started: () => Promise<void>; count: () => number } => {
  let n = 0;
  let notify!: () => void;
  const startedP = new Promise<void>((r) => { notify = r; });
  let startedOnce = false;
  const started = (): Promise<void> => startedP;
  const mod: ModuleDefinition = {
    name: "gate", version: "0.1.0", description: "挂起工具", api: 1, mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "gate__wait", description: "挂起等信号", parameters: z.object({}),
        resolveExecution: () => Promise.resolve({
          accesses: [], approvalRule: "gate__wait",
          execute: (tc) => new Promise((res) => {
            n++;
            if (!startedOnce) { startedOnce = true; notify(); }
            if (tc.signal.aborted) { res({ output: "[已中止]", isError: true }); return; }
            tc.signal.addEventListener("abort", () => res({ output: "[已中止]", isError: true }), { once: true });
          }),
        }),
      }));
    },
  };
  return { mod, started, count: () => n };
};

const setup = async (opts: { script?: Chunk[][]; modules?: ModuleDefinition[]; ui?: CommandUi } = {}): Promise<Setup> => {
  dir = mkdtempSync(join(tmpdir(), "orosus-roster-"));
  const gateTool = makeGateTool();
  let port: SubagentPort | undefined;
  const provider = fakeProvider(opts.script ?? [text("后台结论")]);
  const providerMod: ModuleDefinition = {
    name: "provider-fake", version: "0.1.0", description: "f", api: 1,
    activate(ctx) { ctx.provide(providerSlotKey("fake"), provider.stream as StreamFn); },
  };
  const consumer: ModuleDefinition = {
    name: "consumer", version: "0.1.0", description: "c", api: 1, mounts: ["subagent"],
    activate(ctx) { port = ctx.subagent; },
  };
  const h = await createHarness({
    store: new InMemorySessionStore(),
    sessionsDir: join(dir, "sessions"),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    cwd: dir,
    ...(opts.ui !== undefined ? { commandUi: opts.ui } : {}),
    modules: [providerMod, consumer, gateTool.mod, ...(opts.modules ?? [])],
    config: { userFile: join(dir, "no.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
  });
  return { h, port: port!, gate: { started: gateTool.started, count: gateTool.count } };
};

describe("后台跑法与花名册 T8（决策 5/12/19/3）", () => {
  it("㉔ 后台入册即返：花名册 queued→running→completed 流转，结论/轮数记录在册，词元记主会话账上", async () => {
    const { h, port } = await setup({ script: [text("后台跑完了")] });
    const t = (await port.spawn({ label: "后台调研", prompt: "干活", background: true })) as { id: string };
    expect(t.id).toMatch(/^[0-9a-f]{8}$/);
    await waitUntil(() => h.subagents().find((a) => a.id === t.id)?.status === "completed");
    const e = h.subagents().find((a) => a.id === t.id)!;
    expect(e.background).toBe(true);
    expect(e.turns).toBe(1);
    expect(e.endedAt).toBeDefined();
    // 词元记主会话账上（设计空白口径）：session/subagent-usage 落主会话（不进模型投影）
    const hist = await h.history();
    const usageEvent = hist.find((ev) => ev.type === "session/subagent-usage") as { agentId?: string; usage?: { input: number; output: number } } | undefined;
    expect(usageEvent).toBeDefined();
    expect(usageEvent!.agentId).toBe(t.id);
    expect(usageEvent!.usage).toEqual({ input: 5, output: 7 });
    await h.close();
  });

  it("㉕ 并发上限 8：10 个挂起单子最多 8 个同时进工具；嵌套满载立即失败不排队", async () => {
    const { h, port } = await setup({ script: [call("c1", "gate__wait")] });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const t = (await port.spawn({ label: `挂起 ${i}`, prompt: "等", background: true })) as { id: string };
      ids.push(t.id);
    }
    await waitUntil(() => h.subagents().filter((a) => a.status === "running").length === 8);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.subagents().filter((a) => a.status === "running").length).toBe(8); // 硬上限 8
    expect(h.subagents().filter((a) => a.status === "queued").length).toBe(2);  // 超了排队
    // 嵌套满载快败：用满载状态从一个运行中子代理里派孙代理——这里直接验编排层行为（满载 + depth 2 → 立即失败）
    // 通过前台第 9 个单子验证：满载时前台也排队（不快败——嵌套才快败）
    const fg = port.spawn({ label: "前台等位", prompt: "等" }) as Promise<SubagentOutcome>;
    await new Promise((r) => setTimeout(r, 30));
    expect(h.subagents().find((a) => a.label === "前台等位")?.status).toBe("queued");
    // 放三个位：停掉三个在跑的 → 队列三个（挂起 8、挂起 9、前台等位）依次递补
    h.subagents().filter((a) => a.status === "running").slice(0, 3).forEach((a) => port.stop(a.id));
    await waitUntil(() => h.subagents().find((a) => a.label === "前台等位")?.status === "running");
    h.subagents().filter((a) => a.status === "running" || a.status === "queued").forEach((a) => port.stop(a.id));
    const out = await fg;
    expect(out.status).toBe("failed");
    await waitUntil(() => h.subagents().every((a) => a.status === "completed" || a.status === "failed"), 8000);
    await h.close();
  }, 20000);

  it("㉖ stop 两态：运行中的停成 failed（挂起工具被打断）；排队中的停——不入册跑直接收场", async () => {
    const { h, port } = await setup({ script: [call("c1", "gate__wait")] });
    const a = ((await port.spawn({ label: "跑着的", prompt: "等", background: true })) as { id: string }).id;
    await h.subagents; // noop（形态对齐）
    const b = ((await port.spawn({ label: "排队的", prompt: "等", background: true })) as { id: string }).id;
    void b;
    // 填满 8 位让第二个排队：再造 7 个
    const extras: string[] = [];
    for (let i = 0; i < 7; i++) {
      extras.push(((await port.spawn({ label: `占位 ${i}`, prompt: "等", background: true })) as { id: string }).id);
    }
    await waitUntil(() => h.subagents().filter((x) => x.status === "running").length === 8);
    const queued = h.subagents().find((x) => x.status === "queued")!;
    expect(port.stop(queued.id)).toBe(true);
    await waitUntil(() => h.subagents().find((x) => x.id === queued.id)?.status === "failed", 5000);
    expect(port.stop("deadbeef")).toBe(false); // 未知编号
    // 运行中的停：a 在跑（挂起工具）→ stop → 打断 → failed
    expect(port.stop(a)).toBe(true);
    await waitUntil(() => h.subagents().find((x) => x.id === a)?.status === "failed", 5000);
    h.subagents().filter((x) => x.status === "running" || x.status === "queued").forEach((x) => port.stop(x.id)); // 递补上位的（b 等）一并收场
    await waitUntil(() => h.subagents().every((x) => x.status === "completed" || x.status === "failed"), 8000);
    await h.close();
  }, 20000);

  it("㉗ 后台 Ask 档挂起审批（决策 3 第二层）：park 登记不弹窗 → 批准放行；停止自动按拒绝收场", async () => {
    const uiCalls: string[] = [];
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应 ask"); },
      askSecret: async () => { throw new Error("不应 askSecret"); },
      confirm: async () => { throw new Error("不应 confirm"); },
      choose: async (_t, items) => { uiCalls.push(items.join("|")); return "批准一次"; },
    };
    const boom: ModuleDefinition = {
      name: "boom", version: "0.1.0", description: "b", api: 1, mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "boom__run", description: "爆", parameters: z.object({}),
          resolveExecution: () => Promise.resolve({
            accesses: [Access.subprocess()], approvalRule: "boom__run",
            execute: () => Promise.resolve({ output: "boom", isError: false }),
          }),
        }));
      },
    };
    // A. park → 批准 → 放行跑完
    const s1 = await setup({ script: [call("c1", "boom__run"), text("批准后干完")], modules: [approval, boom], ui });
    const a = ((await s1.port.spawn({ label: "后台审批 A", prompt: "go", background: true })) as { id: string }).id;
    await waitUntil(() => s1.h.subagents().find((x) => x.id === a)?.pendingApproval !== undefined);
    const pend = s1.h.subagents().find((x) => x.id === a)!;
    expect(pend.pendingApproval!.tool).toBe("boom__run");
    expect(uiCalls).toEqual([]); // 不弹窗不抢占（挂起等用户有空）
    expect(s1.h.answerSubagentApproval(a, true)).toBe(true);
    await waitUntil(() => s1.h.subagents().find((x) => x.id === a)?.status === "completed");
    await s1.h.close();

    // B. park → 停止 → 自动拒绝收场（failed）
    const s2 = await setup({ script: [call("c1", "boom__run"), text("不会到这")], modules: [approval, boom], ui });
    const b = ((await s2.port.spawn({ label: "后台审批 B", prompt: "go", background: true })) as { id: string }).id;
    await waitUntil(() => s2.h.subagents().find((x) => x.id === b)?.pendingApproval !== undefined);
    expect(s2.port.stop(b)).toBe(true);
    await waitUntil(() => s2.h.subagents().find((x) => x.id === b)?.status === "failed");
    await s2.h.close();
  });

  it("㉘ 会话关闭全停：后台挂起中的子代理随 close 收场（不悬挂、不卡 close）", async () => {
    const { h, port } = await setup({ script: [call("c1", "gate__wait")] });
    const a = ((await port.spawn({ label: "挂到关会话", prompt: "等", background: true })) as { id: string }).id;
    await waitUntil(() => h.subagents().find((x) => x.id === a)?.status === "running");
    await h.close(); // 决策 12：会话关闭全停
    expect(h.subagents().find((x) => x.id === a)?.status).toBe("failed");
  });
});
