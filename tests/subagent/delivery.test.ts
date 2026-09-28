import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { providerSlotKey, type Chunk, type StreamFn } from "@orosus/contracts/provider";
import { defineTool } from "@orosus/contracts/tool";
import type { ModuleDefinition, SubagentPort } from "@orosus/contracts/module";

let cur: Awaited<ReturnType<typeof createHarness>> | undefined; // 当前活跃 harness——测试体末尾显式 close 照旧，断言中途失败由 afterEach 兜底（close 幂等）
const dirs: string[] = [];
afterEach(async () => {
  await cur?.close();
  cur = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const text = (t: string): Chunk[] => [{ type: "text/delta", text: t }, { type: "finish", kind: "stop" }];
const call = (callId: string, name: string): Chunk[] => [
  { type: "toolcall/argumentsDelta", callId, name, argumentsDelta: "{}" },
  { type: "finish", kind: "stop" },
];
const waitUntil = async (cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!await cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
};

interface Setup {
  h: Awaited<ReturnType<typeof createHarness>>;
  port: SubagentPort;
  hangStarted: () => Promise<void>;
  releaseHang: () => void;
}

/** hang__hold 工具：挂起直到外部放行（忙时送回的「主 turn 在跑」道具）。 */
const setup = async (script: Chunk[][]): Promise<Setup> => {
  const dir = mkdtempSync(join(tmpdir(), "orosus-delivery-"));
  dirs.push(dir);
  let port: SubagentPort | undefined;
  let startedResolve!: () => void;
  const started = new Promise<void>((r) => { startedResolve = r; });
  let release: () => void = () => {};
  const releaseP = new Promise<void>((r) => { release = r; });
  const provider = fakeProvider(script);
  const providerMod: ModuleDefinition = {
    name: "provider-fake", version: "0.1.0", description: "f", api: 1,
    activate(ctx) { ctx.provide(providerSlotKey("fake"), provider.stream as StreamFn); },
  };
  const consumer: ModuleDefinition = {
    name: "consumer", version: "0.1.0", description: "c", api: 1, mounts: ["subagent"],
    activate(ctx) { port = ctx.subagent; },
  };
  const hang: ModuleDefinition = {
    name: "hang", version: "0.1.0", description: "h", api: 1, mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "hang__hold", description: "挂起", parameters: z.object({}),
        resolveExecution: () => Promise.resolve({
          accesses: [], approvalRule: "hang__hold",
          execute: () => { startedResolve(); return releaseP.then(() => ({ output: "放行", isError: false })); },
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
    modules: [providerMod, consumer, hang],
    config: { userFile: join(dir, "no.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
  });
  cur = h; // TS-13：登记当前 harness，afterEach 兜底 close
  return { h, port: port!, hangStarted: () => started, releaseHang: release };
};

const eventsOf = async (h: Setup["h"]): Promise<{ type: string; [k: string]: unknown }[]> =>
  (await h.history()) as unknown as { type: string; [k: string]: unknown }[];

describe("后台结论送回 T9（决策 17：followUp 缝 + 忙时排队 + 自动续跑）", () => {
  it("㉙ 闲时送回：后台跑完 → 自动开无用户消息的送回轮——steering 注入送回行 + 模型接话，不落 user/message", async () => {
    // 主 provider 脚本：请求 1 = 后台单子；请求 2 = 送回轮的应答
    const s = await setup([text("后台的结论是好的"), text("收到结论，已了解")]);
    const t = ((await s.port.spawn({ label: "闲时调研", prompt: "干", background: true })) as { id: string }).id;
    await waitUntil(() => s.h.subagents().find((a) => a.id === t)?.status === "completed");
    await waitUntil(async () => (await eventsOf(s.h)).some((e) => e.type === "assistant/message"), 5000);
    const evts = await eventsOf(s.h);
    // m4-6 T7 后会话首条 steering 是日期系统行（host 源）——送回行按内容找（sourceModule = tool-subagent）
    const steerLines = evts.filter((e) => e.type === "agent/steering-message")
      .flatMap((e) => ((e as { messages?: { text?: string; sourceModule?: string }[] }).messages ?? []));
    const line = steerLines.find((m) => (m.text ?? "").includes("闲时调研"));
    expect(line).toBeDefined();
    expect(line!.text).toContain("[非用户输入]");
    expect(line!.text).toContain("闲时调研 完成：后台的结论是好的");
    expect(line!.sourceModule).toBe("tool-subagent");
    expect(evts.some((e) => e.type === "user/message")).toBe(false); // 送回轮不落用户消息
    const final = evts.filter((e) => e.type === "assistant/message").at(-1) as { content?: { kind: string; text: string }[] };
    expect(final.content!.some((p) => p.text.includes("收到结论"))).toBe(true);
    await s.h.close();
  }, 15000);

  it("㉚ 忙时送回：主 turn 在跑 → 送回排队；主 turn 停止边界收下注入，模型接话后收尾", async () => {
    // 请求序：主轮 1（挂起工具）→ 后台单子（请求 2）→ 主轮停止边界注入后的请求 3
    const s = await setup([call("m1", "hang__hold"), text("后台结论"), text("忙时也收到了")]);
    const promptP = s.h.prompt("去干活");
    await s.hangStarted();
    const t = ((await s.port.spawn({ label: "忙时调研", prompt: "干", background: true })) as { id: string }).id;
    await waitUntil(() => s.h.subagents().find((a) => a.id === t)?.status === "completed");
    await new Promise((r) => setTimeout(r, 100)); // 送回落积压（主 turn 在跑——不自动开轮）
    const evtsBusy = await eventsOf(s.h);
    expect(evtsBusy.some((e) => e.type === "agent/steering-message" && JSON.stringify(e).includes("忙时调研"))).toBe(false); // 排队中未注入（m4-6 T7 后首轮有日期系统行——不断言零 steering）
    s.releaseHang();
    await promptP;
    const evts = await eventsOf(s.h);
    const steerLine = evts.filter((e) => e.type === "agent/steering-message")
      .flatMap((e) => ((e as { messages?: { text?: string }[] }).messages ?? []))
      .find((m) => (m.text ?? "").includes("忙时调研"));
    expect(steerLine).toBeDefined();
    expect(steerLine!.text).toContain("忙时调研 完成：后台结论");
    const final = evts.filter((e) => e.type === "assistant/message").at(-1) as { content?: { kind: string; text: string }[] };
    expect(final.content!.some((p) => p.text.includes("忙时也收到"))).toBe(true);
    await s.h.close();
  }, 15000);

  it("㉛ 失败单子也送回：送回行带「失败」与错误首行", async () => {
    // 后台单子第一请求即报错（finish error）→ outcome failed → 送回「失败：<错误>」
    const s = await setup([
      [{ type: "finish", kind: "error", errorMessage: "端点炸了" }],
      text("送回轮接话"),
    ]);
    await s.port.spawn({ label: "失败单", prompt: "干", background: true });
    await waitUntil(async () => (await eventsOf(s.h)).some((e) => e.type === "agent/steering-message" && JSON.stringify(e).includes("失败单")), 5000);
    const steerLine = (await eventsOf(s.h)).filter((e) => e.type === "agent/steering-message")
      .flatMap((e) => ((e as { messages?: { text?: string }[] }).messages ?? []))
      .find((m) => (m.text ?? "").includes("失败单"));
    expect(steerLine!.text).toContain("失败单 失败：端点炸了");
    await s.h.close();
  }, 15000);

  it("㉜ 不打断打字：送回轮进行中用户发消息——不抛「已有进行中的 turn」，送回轮收尾后紧接进", async () => {
    // 送回轮 = 请求 2（挂起工具）→ 用户 prompt 等它 → 放行 → 送回轮完 → 用户消息进（请求 3）
    const s = await setup([text("后台结论"), call("d1", "hang__hold"), text("用户回合答复")]);
    const t = ((await s.port.spawn({ label: "让路调研", prompt: "干", background: true })) as { id: string }).id;
    await waitUntil(() => s.h.subagents().find((a) => a.id === t)?.status === "completed");
    await s.hangStarted(); // 送回轮跑到挂起工具（steering 已注入、模型要工具结果）
    const userP = s.h.prompt("我插一句话");
    await new Promise((r) => setTimeout(r, 100));
    s.releaseHang();
    await userP; // 不抛——等送回轮收尾后紧接进
    const evts = await eventsOf(s.h);
    const userMsgs = evts.filter((e) => e.type === "user/message") as unknown as { content?: { kind: string; text: string }[] }[];
    expect(userMsgs.some((u) => u.content!.some((p) => p.text.includes("我插一句话")))).toBe(true);
    const final = evts.filter((e) => e.type === "assistant/message").at(-1) as { content?: { kind: string; text: string }[] };
    expect(final.content!.some((p) => p.text.includes("用户回合答复"))).toBe(true);
    await s.h.close();
  }, 15000);
});
