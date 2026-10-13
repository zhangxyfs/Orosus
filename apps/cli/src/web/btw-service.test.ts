/** web 批 W5 伴生测试：btw 服务端多轮化 + 只读工具面（简报 Step 1 六条）。
 *  分层：①-⑤ 走 HostedSession 注入面（cmdrouter.test ⑧ 同款缝：captureProvider 剧本 +
 *  BUILTIN_MODULES 自带 tool-fs——三只读工具从主图 tools.list() 过滤取得）；⑥ CLI 形态回归
 *  走 buildBtwRequest 纯函数桩（快照钉无 opts 产出与现状逐字节一致——GC1 红线）。
 *  六条对应：①多轮请求体（前轮问答 + 最新主历史，每轮重取）；②工具循环（read 被执行、结果回注）；
 *  ③保险丝第 8 轮熔断 error 帧；④非白名单工具不出现在请求工具面；⑤零落盘（主 history 与子代理目录
 *  均无 btw 痕迹）；⑥CLI 形态回归快照。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCwd, type SessionEvent } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { MODULE_API_VERSION, type CommandUi, type ModuleDefinition } from "@orosus/contracts/module";
import { providerSlotKey, type Chunk, type ProviderRequest } from "@orosus/contracts/provider";
import { HostedSession } from "./hosted.ts";
import { askBtw } from "./btw-service.ts";
import type { BtwFrame } from "./hosted.ts";
import { buildBtwRequest } from "../btw-cmd.ts";

/** 轮询等待（25ms 步进；谓词可异步；超时抛错——cmdrouter.test 同款）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const text = (t: string): Chunk[] => [{ type: "text/delta", text: t }, { type: "finish", kind: "stop" }];
/** read 调用剧本：path 给绝对路径（tool-fs root = 进程 cwd〔M1 决策〕，测试文件落在 tmp cwd——
 *  read 明文接受绝对路径）。 */
const readCall = (callId: string, path: string): Chunk[] => [
  { type: "toolcall/argumentsDelta", callId, name: "tool-fs__read", argumentsDelta: JSON.stringify({ path }) },
  { type: "finish", kind: "stop" },
];

/** 无头 CommandUi（cmdrouter.test 同款——btw 面无交互，fail-closed 即可）。 */
const headlessUi: CommandUi = {
  ask: async () => { throw new Error("无交互环境"); },
  askSecret: async () => { throw new Error("无交互环境"); },
  choose: async () => { throw new Error("无交互环境"); },
  confirm: async () => { throw new Error("无交互环境"); },
};

/** 请求捕获型 fake provider 模块（cmdrouter.test ⑧ 同款）。 */
const captureProvider = (name: string, script: Chunk[][]): { mod: ModuleDefinition; requests: ProviderRequest[] } => {
  const { stream, requests } = fakeProvider(script);
  const mod: ModuleDefinition = {
    name: `provider-${name}`, version: "0.1.0", description: `fake provider ${name}`, api: MODULE_API_VERSION,
    activate(ctx) { ctx.provide(providerSlotKey(name), stream); },
  };
  return { mod, requests };
};

/** 起一个托管会话（btw 测试通用装配：fake provider + tool-fs 走 BUILTIN_MODULES）。 */
const setupSession = (script: Chunk[][], home: string, cwd: string): { hs: HostedSession; requests: ProviderRequest[]; frames: BtwFrame[] } => {
  const { mod, requests } = captureProvider("fake", script);
  const hs = new HostedSession({
    cwd,
    commandUi: headlessUi,
    modules: [mod],
    config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "fake/x" } },
    sessionsRoot: join(home, "sessions"),
  });
  const frames: BtwFrame[] = [];
  hs.onBtw((f) => frames.push({ ...f }));
  return { hs, requests, frames };
};

describe("web W5：btw 服务端多轮化 + 只读工具面", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-w5-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-w5-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    prevHome = process.env["OROSUS_HOME"];
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env["OROSUS_HOME"];
    else process.env["OROSUS_HOME"] = prevHome;
    for (const c of cwds.splice(0)) {
      try { rmSync(c, { recursive: true, force: true }); } catch { /* 迟到句柄留给系统 tmp */ }
    }
    while (homes.length > 0) {
      const h = homes.pop()!;
      try { rmSync(h, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  });

  it("① 多轮：第二问请求体含第一轮问答 + 最新主历史（每轮重取）+ 尾追本次问", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    // 剧本序：主轮回答 → autoTitle 标题 → btw 第一问 → btw 第二问
    const { hs, requests, frames } = setupSession([
      text("主对话回答"),
      text("会话标题"),
      text("第一轮答案"),
      text("第二轮答案"),
    ], home, cwd);
    await hs.ready;
    await hs.dispatch("主对话问题"); // 主历史锚点（btw 每轮重取的最新主历史来源）
    await waitFor(async () => (await hs.replayAfter(0)).some((e) => e.type === "session/label")); // autoTitle 剧本段消费完

    askBtw(hs, "btw-1", "第一问");
    await waitFor(() => frames.some((f) => f.phase === "answer" && f.round === 1));
    askBtw(hs, "btw-1", "第二问");
    await waitFor(() => frames.some((f) => f.phase === "answer" && f.round === 2));

    // 第一问请求：主历史 + 尾追问（rounds 空）
    const r1 = requests[2]!;
    expect(JSON.stringify(r1.messages)).toContain("主对话问题");
    expect(JSON.stringify(r1.messages)).toContain("主对话回答");
    expect(r1.messages.at(-1)).toMatchObject({ role: "user", content: [{ kind: "text", text: "第一问" }] });
    // 第二问请求：主历史（每轮重取）+ 第一轮问答平铺 + 尾追第二问。首条 user = 日期系统行
    // （harness 每轮 steering 缝注入的消息位系统行——投影为 user 消息，主对话既有形态）
    const r2 = requests[3]!;
    const roles = r2.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "user", "assistant", "user", "assistant", "user"]);
    expect(JSON.stringify(r2.messages)).toContain("主对话问题"); // 最新主历史仍在（重取）
    expect(JSON.stringify(r2.messages)).toContain("第一问");
    expect(JSON.stringify(r2.messages)).toContain("第一轮答案");
    expect(r2.messages.at(-1)).toMatchObject({ role: "user", content: [{ kind: "text", text: "第二问" }] });
    // system：只读工具版话术（工具允用 + 仍只感知主对话）
    expect(r2.system).toContain("side-question assistant");
    expect(r2.system).not.toContain("You have NO tools");
    // 帧形：tab + round 随帧
    expect(frames.every((f) => f.tab === "btw-1")).toBe(true);
    expect(frames.some((f) => f.phase === "answering" && f.round === 2)).toBe(true);
    await hs.close();
  }, 60_000);

  it("② 工具循环：剧本先回 call tool-fs__read 再回文本——read 被执行、结果回注下一请求、tool 帧", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeFileSync(join(cwd, "note.txt"), "查证内容：答案是 42", "utf8"); // read 目标（绝对路径进剧本）
    const { hs, requests, frames } = setupSession([
      readCall("c1", join(cwd, "note.txt")),
      text("查证后的答案"),
    ], home, cwd);
    await hs.ready;

    askBtw(hs, "btw-1", "note.txt 里写了什么");
    await waitFor(() => frames.some((f) => f.phase === "answer"));
    expect(frames.some((f) => f.phase === "answer" && f.text === "查证后的答案")).toBe(true);

    // 第二次请求：尾对 = assistant(带 toolCalls) + toolResult（read 真执行、输出回注）
    const msgs = requests[1]!.messages;
    const asst = msgs.at(-2) as { role: string; toolCalls?: { callId: string; name: string }[] };
    const toolMsg = msgs.at(-1) as { role: string; callId: string; output: string; isError: boolean };
    expect(asst).toMatchObject({ role: "assistant" });
    expect(asst.toolCalls?.[0]).toMatchObject({ callId: "c1", name: "tool-fs__read" });
    expect(toolMsg).toMatchObject({ role: "toolResult", callId: "c1", isError: false });
    expect(toolMsg.output).toContain("42"); // read 执行结果（行号格式 N→文本）
    // tool 相位帧（前端显「查证中…」——本任务只管帧形）
    expect(frames.some((f) => f.phase === "tool" && f.tab === "btw-1" && f.round === 1)).toBe(true);
    await hs.close();
  }, 60_000);

  it("③ 保险丝：剧本永远回 call——第 8 轮熔断回 error 帧（不再执行、不再发第 9 次请求）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeFileSync(join(cwd, "note.txt"), "内容", "utf8");
    const { hs, requests, frames } = setupSession([readCall("c-always", join(cwd, "note.txt"))], home, cwd); // fakeProvider 剧本耗尽钳位重复末段
    await hs.ready;

    askBtw(hs, "btw-1", "一直查");
    await waitFor(() => frames.some((f) => f.phase === "error"));
    const err = frames.find((f) => f.phase === "error")!;
    expect(err.tab).toBe("btw-1");
    expect(err.text).toContain("8"); // 保险丝轮数进文案
    expect(requests.length).toBe(8); // 恰第 8 轮熔断——无第 9 次请求
    expect(frames.some((f) => f.phase === "answer")).toBe(false); // 未产出答案
    await hs.close();
  }, 60_000);

  it("④ 白名单：请求工具面恰三只读工具（read/grep/glob）——write/edit/bash 等主图工具不出面", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const { hs, requests } = setupSession([text("答")], home, cwd);
    await hs.ready;

    askBtw(hs, "btw-1", "问");
    await waitFor(() => requests.length >= 1);
    const names = requests[0]!.tools.map((t) => t.name).toSorted();
    expect(names).toEqual(["tool-fs__glob", "tool-fs__grep", "tool-fs__read"]);
    // schema 面完整（ToolSpec 三件——模型可调）
    for (const spec of requests[0]!.tools) {
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.parameters).toBeDefined();
    }
    await hs.close();
  }, 60_000);

  it("⑤ 零落盘：主会话 history 无 btw 痕迹、无子代理目录（含工具执行后）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeFileSync(join(cwd, "note.txt"), "内容", "utf8");
    const { hs, frames } = setupSession([
      readCall("c1", join(cwd, "note.txt")),
      text("答"),
    ], home, cwd);
    await hs.ready;

    askBtw(hs, "btw-1", "note.txt 里写了什么");
    await waitFor(() => frames.some((f) => f.phase === "answer"));

    // 主会话 history：无 user/assistant/tool 事件（btw 不经 loop/store——D6）
    const events = await hs.replayAfter(0);
    const traces = events.filter((e: SessionEvent) =>
      e.type === "user/message" || e.type === "assistant/message" || e.type === "tool/call" || e.type === "tool/result");
    expect(traces).toHaveLength(0);
    // 子代理目录：无 agents_<id>（不进花名册 D5）——agents/ 本体是主日志标准布局（session.jsonl），
    // 只有子代理会占 agents_* 子目录
    const sessDir = join(home, "sessions", encodeCwd(cwd), hs.sid);
    expect(existsSync(sessDir)).toBe(true); // 会话本体在（托管装配）
    const agentsEntries = existsSync(join(sessDir, "agents")) ? readdirSync(join(sessDir, "agents")) : [];
    expect(agentsEntries.filter((n) => n.startsWith("agents_"))).toHaveLength(0);
    expect(agentsEntries).toContain("session.jsonl"); // 主日志标准布局在——btw 痕迹为零与之对照
    await hs.close();
  }, 60_000);

  it("⑥ CLI 形态回归：buildBtwRequest 无 opts 产出与现状逐字节一致（快照——GC1 红线）", async () => {
    const ev = (seq: number, type: string, fields: Record<string, unknown> = {}): SessionEvent =>
      ({ v: 1, id: `e${seq}`, parentId: null, seq, ts: "2026-10-13T00:00:00.000Z", type, ...fields }) as SessionEvent;
    const events = [
      ev(1, "user/message", { content: [{ kind: "text", text: "主线问题" }] }),
      ev(2, "assistant/message", { content: [{ kind: "text", text: "主线回答" }] }),
    ];
    const h = { history: async () => events, graph: () => ({ promptSections: () => "SYS_SECTIONS" }) };
    const r = await buildBtwRequest(h, "侧问问看");
    expect(JSON.stringify(r)).toMatchInlineSnapshot(`"{"system":"SYS_SECTIONS\\n\\nYou are a side-question assistant. The user asked a quick question on the side\\nwhile the main agent keeps working — the main conversation is NOT interrupted,\\nand you are not part of it.\\n- The conversation history above is inherited purely as context; answer the\\n  question from it.\\n- You have NO tools, and there is no follow-up turn — answer directly in this\\n  single response.\\n- If the answer is not in the conversation, say so plainly instead of guessing.\\n  Never promise to look something up or take any action.\\n- Reply in the same language as the question.","messages":[{"role":"user","content":[{"kind":"text","text":"主线问题"}]},{"role":"assistant","content":[{"kind":"text","text":"主线回答"}]},{"role":"user","content":[{"kind":"text","text":"侧问问看"}]}]}"`);
    // opts 显式 none 与无 opts 同形（CLI 单轮无工具形态的显式写法）
    const rNone = await buildBtwRequest(h, "侧问问看", { tools: "none" });
    expect(JSON.stringify(rNone)).toBe(JSON.stringify(r));
  });
});
