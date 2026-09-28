import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { providerSlotKey } from "@orosus/contracts/provider";
import type { Chunk, ProviderRequest, StreamFn } from "@orosus/contracts/provider";
import { Access, defineTool } from "@orosus/contracts/tool";
import type { CommandUi, ModuleDefinition, SubagentOutcome, SubagentPort } from "@orosus/contracts/module";
import approval from "@orosus/approval";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 审批接回端到端（M4.5 T2 / 决策 3 两层）：
 *  子代理的工具调用经 agent bus → 主对话关卡（approval 模块 waterfall）——
 *  ask 档弹主界面串行审批队列（前台照常弹）、auto 档照单放行不弹、跟随档随主对话运行期档。
 *  boom__run 声明 subprocess 访问——ask-risky 档必问（decide.ts 管线）。 */

interface Ctx {
  h: Awaited<ReturnType<typeof createHarness>>;
  port: SubagentPort;
  requests: ProviderRequest[];
  uiCalls: { title: string; items: string }[];
  boomRan: () => number;
}

const setup = async (configToml: string, answer: string | "throw"): Promise<Ctx> => {
  dir = mkdtempSync(join(tmpdir(), "orosus-subagent-approval-"));
  writeFileSync(join(dir, "user.toml"), configToml, "utf8");
  let port: SubagentPort | undefined;
  const uiCalls: { title: string; items: string }[] = [];
  const ui: CommandUi = {
    ask: async () => { throw new Error("不应 ask"); },
    askSecret: async () => { throw new Error("不应 askSecret"); },
    confirm: async () => { throw new Error("不应 confirm"); },
    choose: async (title, items) => {
      if (answer === "throw") throw new Error("auto 档不应弹窗");
      uiCalls.push({ title, items: items.join("|") });
      return answer;
    },
  };
  let boomRan = 0;
  const script: Chunk[][] = [
    [{ type: "toolcall/argumentsDelta", callId: "c1", name: "boom__run", argumentsDelta: "{}" }, { type: "finish", kind: "stop" }],
    [{ type: "text/delta", text: "干完了" }, { type: "finish", kind: "stop" }],
  ];
  const provider = fakeProvider(script);
  const providerMod: ModuleDefinition = {
    name: "provider-fake", version: "0.1.0", description: "f", api: 1,
    activate(ctx) { ctx.provide(providerSlotKey("fake"), provider.stream as StreamFn); },
  };
  const consumer: ModuleDefinition = {
    name: "consumer", version: "0.1.0", description: "c", api: 1, mounts: ["subagent"],
    activate(ctx) { port = ctx.subagent; },
  };
  const boom: ModuleDefinition = {
    name: "boom", version: "0.1.0", description: "b", api: 1, mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "boom__run", description: "爆", parameters: z.object({}),
        resolveExecution: () => Promise.resolve({
          accesses: [Access.subprocess()], approvalRule: "boom__run",
          execute: () => { boomRan++; return Promise.resolve({ output: "boom", isError: false }); },
        }),
      }));
    },
  };
  const h = await createHarness({
    store: new InMemorySessionStore(),
    sessionsDir: join(dir, "sessions"),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    commandUi: ui,
    modules: [approval, providerMod, consumer, boom],
    config: { userFile: join(dir, "user.toml"), projectFile: join(dir, "no-proj.toml"), env: {}, cliOverrides: { model: "fake/m" } },
  });
  return { h, port: port!, requests: provider.requests, uiCalls, boomRan: () => boomRan };
};

/** 等到条件成立或超时（后台收场是异步链——测试不赌时序；roster 同款）。 */
const waitUntil = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("子代理审批接回（决策 3：手动配置 > 跟随主对话 > 默认 Ask）", () => {
  it("⑦ 四路：默认 Ask 转发主关卡弹窗批准放行 / 手动 auto 照单放行不弹 / 跟随主 never → auto 不弹 / 手动 ask 压过主 never 仍问", async () => {
    // A. 默认（无 [tool-subagent] 配置）+ 主对话 ask-risky → 转发主关卡 → ask（subprocess 必问）→ 批准一次放行
    const a = await setup("", "批准一次");
    const outA = (await a.port.spawn({ label: "默认问", prompt: "go" })) as SubagentOutcome;
    expect(outA.status).toBe("completed");
    expect(outA.conclusion).toBe("干完了");
    expect(a.uiCalls.length).toBe(1);
    expect(a.uiCalls[0]!.title).toContain("boom__run");
    expect(a.boomRan()).toBe(1); // TS-03 回归钉：批准放行后工具真执行了（旧断言只验「弹了一次窗」——批准链路静默丢工具也全绿）
    await a.h.close();

    // B. 手动 auto（[tool-subagent] approvalMode="auto"）→ 照单放行不弹
    const b = await setup('[tool-subagent]\napprovalMode = "auto"\n', "throw");
    const outB = (await b.port.spawn({ label: "手动 auto", prompt: "go" })) as SubagentOutcome;
    expect(outB.status).toBe("completed");
    expect(b.uiCalls.length).toBe(0); // 不弹窗（auto 模式的子代理根本不产生弹窗——决策 3）
    expect(b.boomRan()).toBe(1);      // TS-03：auto 放行 = 工具照跑（不弹≠不执行）
    await b.h.close();

    // C. 跟随主对话：主 never → 子代理 auto → 不弹
    const c = await setup('[approval]\nmode = "never"\n', "throw");
    const outC = (await c.port.spawn({ label: "跟随 never", prompt: "go" })) as SubagentOutcome;
    expect(outC.status).toBe("completed");
    expect(c.uiCalls.length).toBe(0);
    expect(c.boomRan()).toBe(1);      // TS-03：跟随 never 的基线放行 = 工具照跑（⑨ 的 deny 规则拦截是另一路）
    await c.h.close();

    // D. 手动 ask 压过主 never（手动值优先——严格方向不放宽）：转发带 ask-risky 地板仍问
    const d = await setup('[approval]\nmode = "never"\n\n[tool-subagent]\napprovalMode = "ask"\n', "拒绝");
    const outD = (await d.port.spawn({ label: "手动 ask", prompt: "go" })) as SubagentOutcome;
    expect(d.uiCalls.length).toBe(1);
    expect(d.boomRan()).toBe(0);      // TS-03：拒绝路未执行——与 A/B/C 的「执行」互为对照（旧实现 void boomRan 零覆盖）
    expect(outD.conclusion).toBe("干完了"); // 工具被拒后模型照常收尾（脚本末条文本）——拒绝链路在 T15 场景 3 细验
    await d.h.close();
  });

  it("⑧ CX-01：主对话 ask-always → 子代理工具照问（旧实现载荷钉死 ask-risky——子代理写操作静默放行）", async () => {
    const e = await setup('[approval]\nmode = "ask-always"\n', "批准一次");
    const outE = (await e.port.spawn({ label: "严档跟随", prompt: "go" })) as SubagentOutcome;
    expect(outE.status).toBe("completed");
    expect(e.uiCalls.length).toBe(1); // 旧实现：ask-risky 提示降档 → subprocess「常规读写放行」零询问
    expect(e.boomRan()).toBe(1);
    await e.h.close();
  });

  it("⑨ CX-02：主对话 never + 手写 deny 规则 → 子代理调用被拦（旧实现 auto 档整门跳过——deny 对子代理失效）", async () => {
    const f = await setup(
      '[approval]\nmode = "never"\n\n[[approval.rules]]\neffect = "deny"\ntool = "boom__run"\n',
      "throw", // 从不询问 + deny 命中 → 不该有任何弹窗
    );
    const outF = (await f.port.spawn({ label: "deny 照拦", prompt: "go" })) as SubagentOutcome;
    expect(outF.status).toBe("completed");
    expect(f.uiCalls.length).toBe(0); // auto 语义不自发弹窗
    expect(f.boomRan()).toBe(0);      // 但 deny 规则照拦——工具没跑（旧实现 boomRan=1）
    await f.h.close();
  });

  it("⑩ CX-07 保险丝穿透 park：后台 Ask 档挂起审批无人应 → 不活动超时自动按拒绝收场（旧实现永久占位挂死，只有 stop 能解）", async () => {
    const g = await setup('[tool-subagent]\ninactivityTimeoutMs = 1500\n', "throw"); // 后台 park 不弹窗——choose 不该被调
    const t = (await g.port.spawn({ label: "挂死审批", prompt: "go", background: true })) as { id: string };
    await waitUntil(() => g.h.subagents().find((x) => x.id === t.id)?.pendingApproval !== undefined); // 先钉住确已 park
    expect(g.uiCalls).toEqual([]); // park 挂起不抢占（同 ㉗ A 前置态）
    // 此后一直不答：旧实现 park 只听 answerApproval/stop/settle——保险丝 abort 穿不透 park 链，条目永远
    // running 且 pendingApproval 在册（waitUntil 超时即失败）；修复后 abort 竞速按拒绝收场。
    await waitUntil(() => {
      const e = g.h.subagents().find((x) => x.id === t.id);
      return e !== undefined && (e.status === "completed" || e.status === "failed");
    }, 8000);
    const e = g.h.subagents().find((x) => x.id === t.id)!;
    expect(e.pendingApproval).toBeUndefined(); // 收场摘牌
    expect(e.status).toBe("completed");        // 不活动超时收尾不标失败（abortReason=inactivity——与 fuses ㊟-13 同口径）
    expect(g.boomRan()).toBe(0);               // 挂起的工具从未执行（按拒绝收场）
    await g.h.close();
  }, 15000);
});
