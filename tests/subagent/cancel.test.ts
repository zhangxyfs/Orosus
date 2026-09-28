import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { providerSlotKey, type Chunk, type StreamFn } from "@orosus/contracts/provider";
import { Access, defineTool } from "@orosus/contracts/tool";
import type { ModuleDefinition, SubagentOutcome, SubagentPort } from "@orosus/contracts/module";

/** 取消接线回归钉（2026-09-28 code review）：
 *  CX-04——后台子代理不接派生 turn 的取消信号（主 turn 被 Esc 打断不误杀后台；取消只来自 stop()/保险丝）；
 *  CX-05——并发位/写闸排队接取消信号（abort 即按「已被停止」失败收场，不挂死等位/等闸）。 */

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

/** 手动放行的挂起工具：signal 打断按 [已中止] 收场，release() 放行按 ok 收场——CX-04 场景的道具。 */
const makeHoldTool = (): { mod: ModuleDefinition; started: () => Promise<void>; release: () => void } => {
  let notify!: () => void;
  const startedP = new Promise<void>((r) => { notify = r; });
  let startedOnce = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const mod: ModuleDefinition = {
    name: "hold", version: "0.1.0", description: "挂起", api: 1, mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "hold__go", description: "挂起等放行", parameters: z.object({}),
        resolveExecution: () => Promise.resolve({
          accesses: [], approvalRule: "hold__go",
          execute: (tc) => new Promise((res) => {
            if (!startedOnce) { startedOnce = true; notify(); }
            if (tc.signal.aborted) { res({ output: "[已中止]", isError: true }); return; }
            tc.signal.addEventListener("abort", () => res({ output: "[已中止]", isError: true }), { once: true });
            void gate.then(() => res({ output: "ok", isError: false }));
          }),
        }),
      }));
    },
  };
  return { mod, started: (): Promise<void> => startedP, release: (): void => release() };
};

/** 挂到 signal 打断为止的占位工具（填并发位用——roster ㉕ makeGateTool 同形态）。 */
const makeHangTool = (): ModuleDefinition => ({
  name: "hang", version: "0.1.0", description: "挂起", api: 1, mounts: ["contribute:tool"],
  activate(ctx) {
    ctx.contribute.tool(defineTool({
      name: "hang__wait", description: "挂起等信号", parameters: z.object({}),
      resolveExecution: () => Promise.resolve({
        accesses: [], approvalRule: "hang__wait",
        execute: (tc) => new Promise((res) => {
          if (tc.signal.aborted) { res({ output: "[已中止]", isError: true }); return; }
          tc.signal.addEventListener("abort", () => res({ output: "[已中止]", isError: true }), { once: true });
        }),
      }),
    }));
  },
});

interface Setup {
  h: Awaited<ReturnType<typeof createHarness>>;
  port: SubagentPort;
  hold: { started: () => Promise<void>; release: () => void };
}

const setup = async (script: Chunk[][], opts: { gateTool?: ModuleDefinition } = {}): Promise<Setup> => {
  dir = mkdtempSync(join(tmpdir(), "orosus-cancel-"));
  const holdTool = makeHoldTool();
  let port: SubagentPort | undefined;
  const provider = fakeProvider(script);
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
    modules: [providerMod, consumer, holdTool.mod, makeHangTool(), ...(opts.gateTool !== undefined ? [opts.gateTool] : [])],
    config: { userFile: join(dir, "no.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
  });
  return { h, port: port!, hold: { started: holdTool.started, release: holdTool.release } };
};

describe("取消接线（CX-04/CX-05 修复 2026-09-28 code review）", () => {
  it("CX-04-a 主 turn abort 不杀后台子代理：派生信号断了后台照跑完（completed、无 error）", async () => {
    const s = await setup([call("c1", "hold__go"), text("后台照跑完")]);
    const ctl = new AbortController();
    const a = ((await s.port.spawn({ label: "后台不受扰", prompt: "干", background: true }, { signal: ctl.signal })) as { id: string }).id;
    await s.hold.started(); // 工具已起跑（runOne 信号接线已就位——打断只可能来自那条链）
    ctl.abort();            // 派生它的主 turn 被 Esc——后台独立生命周期，不该被带走
    expect(s.h.subagents().find((x) => x.id === a)!.status).toBe("running"); // 没被误杀
    s.hold.release();       // 放行 → 第二轮交卷
    await waitUntil(() => s.h.subagents().find((x) => x.id === a)?.status === "completed");
    const done = s.h.subagents().find((x) => x.id === a)!;
    expect(done.error).toBeUndefined();
    expect(done.turns).toBe(2);
    await s.h.close();
  }, 15000);

  it("CX-04-b 前台对照照旧被打断：同款信号 abort → failed（决策 11 取消链不动）", async () => {
    const s = await setup([call("c1", "hold__go"), text("到不了")]);
    const ctl = new AbortController();
    const p = s.port.spawn({ label: "前台被打断", prompt: "干" }, { signal: ctl.signal }) as Promise<SubagentOutcome>;
    await s.hold.started();
    ctl.abort();
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.error).toContain("取消");
    await s.h.close();
  }, 15000);

  it("CX-05-a 并发位满时排队中 abort：spawn 按『已被停止』失败收场，不挂死等位；信号已断的排队单即立即收场", async () => {
    const s = await setup([call("c1", "hang__wait")]);
    for (let i = 0; i < 8; i++) {
      await s.port.spawn({ label: `占位 ${i}`, prompt: "等", background: true });
    }
    await waitUntil(() => s.h.subagents().filter((a) => a.status === "running").length === 8);
    const ctl = new AbortController();
    const p = s.port.spawn({ label: "排队的前台", prompt: "干" }, { signal: ctl.signal }) as Promise<SubagentOutcome>;
    await waitUntil(() => s.h.subagents().find((a) => a.label === "排队的前台")?.status === "queued");
    ctl.abort(); // 派生 turn 取消——排队的单子该立即按停单收场（修复前：挂死等位到有位为止）
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.error).toContain("已被停止");
    expect(s.h.subagents().find((a) => a.label === "排队的前台")!.status).toBe("failed");
    // 信号在排队前就断的：直接按停单收场，不为一个起跑即死的单子等位
    const dead = new AbortController();
    dead.abort();
    const out2 = (await s.port.spawn({ label: "起跑即死", prompt: "干" }, { signal: dead.signal })) as SubagentOutcome;
    expect(out2.status).toBe("failed");
    expect(out2.error).toContain("已被停止");
    await s.h.close();
  }, 20000);

  it("CX-05-b 写闸排队中 abort：按『已被停止』失败收场（闸位让出，持闸者不受扰）", async () => {
    // 占闸道具：假 bash（accesses subprocess + 未报备 = 写整仓——决策 24③），挂到 signal 打断为止
    let bashStarted!: () => void;
    const startedP = new Promise<void>((r) => { bashStarted = r; });
    let startedOnce = false;
    const fakeBash: ModuleDefinition = {
      name: "tool-shell", version: "0.1.0", description: "假 bash（占整仓闸）", api: 1, mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "tool-shell__bash", description: "跑命令", parameters: z.object({ command: z.string() }),
          resolveExecution: () => Promise.resolve({
            accesses: [Access.subprocess()], approvalRule: "tool-shell__bash",
            execute: (tc) => new Promise((res) => {
              if (!startedOnce) { startedOnce = true; bashStarted(); }
              if (tc.signal.aborted) { res({ output: "[已中止]", isError: true }); return; }
              tc.signal.addEventListener("abort", () => res({ output: "[已中止]", isError: true }), { once: true });
            }),
          }),
        }));
      },
    };
    const s = await setup([call("c1", "tool-shell__bash", JSON.stringify({ command: "echo hi" })), text("甲完")], { gateTool: fakeBash });
    // 甲：后台 bash 手先持整仓闸并挂住在跑
    const a = ((await s.port.spawn({ label: "持闸的甲", prompt: "跑", background: true })) as { id: string }).id;
    await startedP; // 工具起跑 = 甲已持闸
    // 乙：前台同要整仓 → 排队等闸（并发位已到手，状态 running、writeClaim 在册）
    const ctl = new AbortController();
    const p = s.port.spawn({ label: "等闸的乙", prompt: "跑" }, { signal: ctl.signal }) as Promise<SubagentOutcome>;
    await waitUntil(() => {
      const e = s.h.subagents().find((x) => x.label === "等闸的乙");
      return e !== undefined && e.writeClaim !== undefined;
    });
    ctl.abort(); // 派生 turn 取消——等闸的单子该立即让位收场（修复前：挂死等闸到甲跑完为止）
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.error).toContain("已被停止");
    expect(s.h.subagents().find((x) => x.label === "等闸的乙")!.status).toBe("failed");
    expect(s.h.subagents().find((x) => x.id === a)!.status).toBe("running"); // 持闸者不受扰
    await s.h.close(); // 甲随会话关闭收场（决策 12——stopAll 打断，settle 是异步链不赌时序）
    await waitUntil(() => s.h.subagents().find((x) => x.id === a)?.status === "failed");
  }, 15000);
});
