import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { providerSlotKey, type Chunk, type StreamFn } from "@orosus/contracts/provider";
import { defineTool } from "@orosus/contracts/tool";
import type { ModuleDefinition, SubagentOutcome, SubagentPort } from "@orosus/contracts/module";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const text = (t: string): Chunk[] => [{ type: "text/delta", text: t }, { type: "finish", kind: "stop" }];
const call = (callId: string, name: string, args = "{}"): Chunk[] => [
  { type: "toolcall/argumentsDelta", callId, name, argumentsDelta: args },
  { type: "finish", kind: "stop" },
];

/** 双保险丝 + 收尾轮端到端（2026-09-27 拍板）：撞限不失败——收尾轮交卷 completed + truncated 标注；
 *  不活动超时短值可测（config inactivityTimeoutMs 覆盖）；-1 不限透传。 */

const setup = async (mainScript: Chunk[][], agentScript: Chunk[][], configToml: string): Promise<{ h: Awaited<ReturnType<typeof createHarness>>; port: SubagentPort }> => {
  dir = mkdtempSync(join(tmpdir(), "orosus-fuse-"));
  writeFileSync(join(dir, "user.toml"), configToml, "utf8");
  let port: SubagentPort | undefined;
  const provider = fakeProvider(mainScript);
  const agentProvider = fakeProvider(agentScript);
  const providerMod: ModuleDefinition = {
    name: "provider-fake", version: "0.1.0", description: "f", api: 1,
    activate(ctx) {
      ctx.provide(providerSlotKey("fake"), provider.stream as StreamFn);
      ctx.provide(providerSlotKey("fake2"), agentProvider.stream as StreamFn);
    },
  };
  const consumer: ModuleDefinition = { name: "consumer", version: "0.1.0", description: "c", api: 1, mounts: ["subagent"], activate(ctx) { port = ctx.subagent; } };
  const tickMod: ModuleDefinition = {
    name: "tick", version: "0.1.0", description: "t", api: 1, mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "tick__go", description: "快", parameters: z.object({}),
        resolveExecution: () => Promise.resolve({
          accesses: [], approvalRule: "tick__go",
          execute: () => Promise.resolve({ output: "ok", isError: false }),
        }),
      }));
    },
  };
  const gateMod: ModuleDefinition = {
    name: "gate", version: "0.1.0", description: "g", api: 1, mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "gate__hold", description: "挂起", parameters: z.object({}),
        resolveExecution: () => Promise.resolve({
          accesses: [], approvalRule: "gate__hold",
          execute: (tc) => new Promise((res) => {
            if (tc.signal.aborted) { res({ output: "[已中止]", isError: true }); return; }
            tc.signal.addEventListener("abort", () => res({ output: "[已中止]", isError: true }), { once: true });
          }),
        }),
      }));
    },
  };
  const h = await createHarness({
    store: new InMemorySessionStore(),
    sessionsDir: join(dir, "sessions"),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    cwd: dir,
    modules: [providerMod, consumer, tickMod, gateMod],
    config: { userFile: join(dir, "user.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
  });
  return { h, port: port! };
};

const baseToml = (extra: string): string =>
  `[tool-subagent]\nmodel = "fake2/agent-m"\n${extra}`;

describe("子代理双保险丝与收尾轮（2026-09-27 拍板）", () => {
  it("㊿-10 收尾轮：轮数到顶不失败——禁工具+注入总结指令再给一轮，completed + truncated=max_turns，结论为总结", async () => {
    // 工种 maxTurns=2（走 spawn 请求路径验证钳位透传）：轮1 工具调用 → 到顶 armed → 轮2 注入总结 + 工具被拒 → 文本交卷
    const s = await setup(
      [text("主对话")],
      [call("a1", "tick__go"), call("a2", "tick__go"), text("总结：已读完核心文件，未完成外围扫描，建议拆分续派")],
      baseToml(""),
    );
    const out = (await s.port.spawn({ label: "撞限调研", prompt: "干", maxTurns: 2 })) as SubagentOutcome;
    expect(out.status).toBe("completed"); // 不再是 failed——收尾轮交卷
    expect(out.truncated).toBe("max_turns");
    expect(out.conclusion).toContain("总结：已读完核心文件");
    expect(out.turns).toBe(3); // 2 轮工作 + 1 轮收尾
    await s.h.close();
  }, 15000);

  it("㊿-11 -1 不限：工种声明 -1 时 4 轮照跑不撞限（无 truncated）；配 3 轮的对照组撞限", async () => {
    const su = await setup(
      [text("主对话")],
      [call("a1", "tick__go"), call("a2", "tick__go"), call("a3", "tick__go"), call("a4", "tick__go"), text("跑完了")],
      baseToml(""),
    );
    const unlimited = (await su.port.spawn({ label: "不限", prompt: "干", maxTurns: -1 })) as SubagentOutcome;
    expect(unlimited.status).toBe("completed");
    expect(unlimited.truncated).toBeUndefined(); // 4 轮 < 无限——不撞
    expect(unlimited.turns).toBe(5);
    await su.h.close();
    const sc = await setup( // 独立 harness：fakeProvider 顺序消费，共享实例会接续脚本位
      [text("主对话")],
      [call("b1", "tick__go"), call("b2", "tick__go"), call("b3", "tick__go"), text("收尾交卷")],
      baseToml(""),
    );
    const capped = (await sc.port.spawn({ label: "限3", prompt: "干", maxTurns: 3 })) as SubagentOutcome;
    expect(capped.status).toBe("completed");
    expect(capped.truncated).toBe("max_turns"); // 对照组撞限走收尾轮
    expect(capped.turns).toBe(4); // 3 轮工作 + 1 轮收尾
    await sc.h.close();
  }, 20000);

  it("㊿-12 settings 键优先于工种：[tool-subagent] maxTurns=2 压过工种声明的 10", async () => {
    const s = await setup(
      [text("主对话")],
      [call("a1", "tick__go"), call("a2", "tick__go"), text("交卷")], // r3 = 收尾轮文本
      baseToml("maxTurns = 2\n"),
    );
    const out = (await s.port.spawn({ label: "被压", prompt: "干", maxTurns: 10 })) as SubagentOutcome;
    expect(out.truncated).toBe("max_turns");
    expect(out.turns).toBe(3); // settings 2 生效（10 被压）
    await s.h.close();
  }, 15000);

  it("㊿-13 不活动超时收尾：inactivityTimeoutMs=1500 下挂死工具 → completed + truncated=inactivity（不标失败）", async () => {
    const s = await setup(
      [text("主对话")],
      [call("a1", "gate__hold")], // 挂死（无 abort 不返）——无事件流
      baseToml("inactivityTimeoutMs = 1500\n"),
    );
    const out = (await s.port.spawn({ label: "挂死", prompt: "等" })) as SubagentOutcome;
    expect(out.status).toBe("completed"); // 超时收尾不标失败
    expect(out.truncated).toBe("inactivity");
    await s.h.close();
  }, 15000);

  it("㊿-14 总时长兜底：totalTimeoutMs=1500 下持续活动也不许超过——completed + truncated=total_timeout", async () => {
    // 代理脚本轮轮工具调用（gate 挂起会被收尾轮禁工具……改用快速往返保持活动）：直接给挂死 + inactivity 关掉，走 total
    const s = await setup(
      [text("主对话")],
      [call("a1", "gate__hold")],
      baseToml("totalTimeoutMs = 1500\ninactivityTimeoutMs = -1\n"),
    );
    const out = (await s.port.spawn({ label: "总时长", prompt: "等" })) as SubagentOutcome;
    expect(out.status).toBe("completed");
    expect(out.truncated).toBe("total_timeout");
    await s.h.close();
  }, 15000);
});
