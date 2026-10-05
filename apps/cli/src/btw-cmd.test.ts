import { describe, it, expect } from "vitest";
import type { SessionEvent, Harness } from "@orosus/core";
import type { Chunk, ModelMessage } from "@orosus/contracts/provider";
import { stripAnsi } from "./tui/width.ts";
import type { FullApp } from "./tui/fullapp.ts";
import {
  BTW_ROLE_PROMPT, BTW_USAGE_HINT, buildBtwRequest, openBtw, reopenBtw, lastBtwArchive,
  renderBtwView, stripTrailingDanglingToolCalls, btwTitle,
  type BtwRequestSource, type BtwStreamReq, type BtwDeps, type BtwSlot,
} from "./btw-cmd.ts";

/** 最小事件（信封字段按 SessionEvent 形状补齐——deriveMessages 只读 type 与载荷字段）。 */
const ev = (seq: number, type: string, fields: Record<string, unknown> = {}): SessionEvent =>
  ({ v: 1, id: `e${seq}`, parentId: null, seq, ts: "2026-10-03T00:00:00.000Z", type, ...fields }) as SessionEvent;

const userEv = (seq: number, text: string): SessionEvent => ev(seq, "user/message", { content: [{ kind: "text", text }] });
const asstEv = (seq: number, text: string): SessionEvent => ev(seq, "assistant/message", { content: [{ kind: "text", text }] });

/** 桩 harness（BtwRequestSource 结构面）：sections 可注入、history 计数可断言。 */
const stubH = (events: SessionEvent[], sections = "SYS_SECTIONS"): BtwRequestSource & { calls: number } => {
  const h = { calls: 0, history: async (): Promise<SessionEvent[]> => { h.calls++; return events; }, graph: () => ({ promptSections: () => sections }) };
  return h;
};

/** 一次性脚本流：记录请求、按序吐 chunk。 */
const scriptStream = (chunks: Chunk[]): { stream: (req: BtwStreamReq) => AsyncIterable<Chunk>; reqs: BtwStreamReq[] } => {
  const reqs: BtwStreamReq[] = [];
  return { reqs, stream: (req) => { reqs.push(req); return (async function* () { yield* chunks; })(); } };
};

/** 闸门流：挂起直到 release——模拟在飞被中止的时序。 */
const gateStream = (): { stream: (req: BtwStreamReq) => AsyncIterable<Chunk>; release: (chunks: Chunk[]) => void } => {
  let release!: (chunks: Chunk[]) => void;
  const gate = new Promise<Chunk[]>((r) => { release = r; });
  return { stream: () => (async function* () { yield* await gate; })(), release };
};

/** 抛错流：消费即抛（require-yield 合规——空 yield* 占位再抛，行为与裸抛一致）。 */
const throwStream = (e: unknown): ((req: BtwStreamReq) => AsyncIterable<Chunk>) =>
  () => (async function* () { yield* []; throw e; })();

/** 桩 FullApp（T3）：捕获 viewText 调用（title/text/opts），pickRowWidth 定宽 60（dock 内容宽惯例）。 */
const stubApp = (): { app: FullApp; calls: { title: string; text: string; opts: { layout?: string; live?: () => string } }[] } => {
  const calls: { title: string; text: string; opts: { layout?: string; live?: () => string } }[] = [];
  const app = {
    viewText: (title: string, text: string, opts: { layout?: string; live?: () => string }) => { calls.push({ title, text, opts }); },
    pickRowWidth: () => 60,
  } as unknown as FullApp;
  return { app, calls };
};
const bareDeps = (): BtwDeps => ({ getH: () => stubH([]) as unknown as Harness });

const deps = (stream: (req: BtwStreamReq) => AsyncIterable<Chunk>, h: BtwRequestSource = stubH([])): BtwDeps =>
  ({ getH: () => h as unknown as Harness, llmStream: stream });

describe("/btw 侧问本体（m5-btw T2）", () => {
  it("① system 拼装：promptSections 现算 + 话术尾段一次拼进（D4——不做每问包装）", async () => {
    const r = await buildBtwRequest(stubH([], "九核心节+模块段"), "为什么这里用 unsafe");
    expect(r.system.startsWith("九核心节+模块段\n\n")).toBe(true); // 主对话系统提示词全带入（cc 同思路）
    expect(r.system.endsWith(BTW_ROLE_PROMPT)).toBe(true); // 话术四要素整段在尾
    expect(r.system).toContain("NOT interrupted");
    expect(r.system).toContain("NO tools");
    expect(r.system).toContain("same language as the question");
  });

  it("② messages 尾追：deriveMessages 同源投影 + 问题消息收尾（继承父上下文不需要 fork 链）", async () => {
    const events = [userEv(1, "主线问题"), asstEv(2, "主线回答")];
    const r = await buildBtwRequest(stubH(events), "侧问：这个 unsafe 必要吗");
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(r.messages.at(-1)).toMatchObject({ role: "user", content: [{ kind: "text", text: "侧问：这个 unsafe 必要吗" }] });
  });

  it("③ 投影尾部防御两态：缺果尾剥 toolCalls（纯工具回合整条去）/ 干净尾不动", async () => {
    // 缺果尾 a：assistant 有正文 + tool/call 已落、result 未落 → 剥 toolCalls 留正文（cc stripInProgress 同族）
    const dangling = [userEv(1, "q"), asstEv(2, "我先看看文件"), ev(3, "tool/call", { callId: "c1", name: "Read", args: {} })];
    const r1 = await buildBtwRequest(stubH(dangling), "侧问");
    expect(r1.messages.at(-2)).toMatchObject({ role: "assistant", content: [{ kind: "text", text: "我先看看文件" }] });
    expect(r1.messages.at(-2)).not.toHaveProperty("toolCalls");
    // 缺果尾 b：纯工具回合（content 空、只挂 toolCalls——主循环不会遇到的形态）→ 整条去
    const pureTool = [userEv(1, "q"), ev(2, "assistant/message", { content: [] }), ev(3, "tool/call", { callId: "c1", name: "Read", args: {} })];
    const r2 = await buildBtwRequest(stubH(pureTool), "侧问");
    expect(r2.messages.map((m) => m.role)).toEqual(["user", "user"]);
    // 干净尾：assistant 收尾 + 上一对 call/result 齐 → 原样透传（末条照样是尾追问题）
    const clean = [userEv(1, "q"), asstEv(2, "我看完了"), ev(3, "tool/call", { callId: "c1", name: "Read", args: {} }), ev(4, "tool/result", { callId: "c1", output: "文件内容" }), asstEv(5, "结论")];
    const r3 = await buildBtwRequest(stubH(clean), "侧问");
    expect(r3.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant", "user"]);
    expect(r3.messages[1]).toMatchObject({ toolCalls: [{ callId: "c1", name: "Read" }] }); // 中段配对不误伤
    // 纯函数面：非 assistant 尾 / 无 toolCalls 尾原样返回同一引用
    const bare = [{ role: "user", content: [{ kind: "text", text: "q" }] }] as ModelMessage[];
    expect(stripTrailingDanglingToolCalls(bare)).toBe(bare);
  });

  it("④ 三态迁移：answering→answer 归档 / 抛错→error 不归档 / 新问先中止旧在飞 / abort-完成同拍已入终态不覆写", async () => {
    // a) answering → answer（归档）
    const a = openBtw(undefined, deps(scriptStream([{ type: "text/delta", text: "答" }, { type: "finish", kind: "stop" }]).stream, stubH([])), "q1");
    expect(a.slot.phase).toBe("answering"); // 开跑即 answering 态
    await a.done;
    expect(a.slot).toMatchObject({ phase: "answer", text: "答" });
    expect(lastBtwArchive()).toEqual({ question: "q1", text: "答" }); // 只有 answer 态归档
    // b) 抛错 → error 不归档
    const b = openBtw(undefined, deps(throwStream(new Error("网络炸了"))), "q2");
    await b.done;
    expect(b.slot).toMatchObject({ phase: "error", text: "网络炸了" });
    expect(lastBtwArchive()).toEqual({ question: "q1", text: "答" }); // 归档仍是 q1——q2 不入
    // c) 新问先中止旧在飞：旧槽切 error「已被新侧问取代」、不入档；新问照常跑完
    const g = gateStream();
    const old = openBtw(undefined, deps(g.stream), "旧问");
    const next = openBtw(undefined, deps(scriptStream([{ type: "text/delta", text: "新答" }, { type: "finish", kind: "stop" }]).stream), "新问");
    g.release([{ type: "finish", kind: "stop" }]); // 旧问流此刻才收流——signal 早已 aborted
    await old.done;
    await next.done;
    expect(old.slot).toMatchObject({ phase: "error", text: "已被新侧问取代" });
    expect(lastBtwArchive()).toEqual({ question: "新问", text: "新答" }); // 归档只有新问
    // d) abort-完成同拍：已入终态（answer）的槽不被后来的 abort 覆写
    const d1 = openBtw(undefined, deps(scriptStream([{ type: "text/delta", text: "先到" }, { type: "finish", kind: "stop" }]).stream), "d1");
    await d1.done; // d1 已 answer 落定
    const d2 = openBtw(undefined, deps(gateStream().stream), "d2"); // 开新问 = abort 旧中止器（已无人在飞）
    expect(d1.slot.phase).toBe("answer"); // 先到者为准——不覆写成「已被新侧问取代」
    expect(d1.slot.text).toBe("先到");
    void d2; // d2 挂在闸门上，测试收尾不等它（进程随套件退出）
  });

  it("⑤ 无参回看数据口（D7）：answer 归档可读；在飞未归档不算（边缘披露口径）", async () => {
    const run = openBtw(undefined, deps(scriptStream([{ type: "text/delta", text: "回看正文" }, { type: "finish", kind: "stop" }]).stream), "回看题");
    await run.done;
    expect(lastBtwArchive()).toEqual({ question: "回看题", text: "回看正文" });
    const g = gateStream();
    const inflight = openBtw(undefined, deps(g.stream), "在飞题");
    expect(lastBtwArchive()).toEqual({ question: "回看题", text: "回看正文" }); // 在飞尚未归档——无参回看不到它
    g.release([{ type: "finish", kind: "error", errorMessage: "收流" }]);
    await inflight.done; // 放成 error 收场（不入档），不留挂起流
    expect(lastBtwArchive()).toEqual({ question: "回看题", text: "回看正文" });
  });

  it("⑥ 空态提示与窗标题契约：BTW_USAGE_HINT 一行不进流区；btwTitle 首行前 16 字超长加 …", () => {
    expect(BTW_USAGE_HINT).toContain("用法");
    expect(BTW_USAGE_HINT).toContain("/btw");
    expect(BTW_USAGE_HINT).not.toContain("\n"); // 一行——toast 通道
    expect(btwTitle("为什么这里用 unsafe")).toBe("侧问 · 为什么这里用 unsafe");
    expect(btwTitle("一二三四五六七八九十一二三四五六七八九十")).toBe("侧问 · 一二三四五六七八九十一二三四五六…");
    expect(btwTitle("首行问题\n第二行上下文")).toBe("侧问 · 首行问题"); // 多行取首行（防框顶打穿）
  });

  it("⑦ 错误格式化：抛 Error 取 message / 抛非 Error 走 String / 带内 finish·error 用 errorMessage、缺省兜底文案", async () => {
    const run = async (stream: (req: BtwStreamReq) => AsyncIterable<Chunk>): Promise<string> => {
      const h = openBtw(undefined, deps(stream), "q");
      await h.done;
      expect(h.slot.phase).toBe("error");
      return h.slot.text;
    };
    expect(await run(throwStream(new Error("超时 300s")))).toBe("超时 300s");
    expect(await run(throwStream("裸字符串"))).toBe("裸字符串");
    expect(await run(scriptStream([{ type: "finish", kind: "error", errorMessage: "llm 口解析失败：provider 不可用" }]).stream))
      .toBe("llm 口解析失败：provider 不可用");
    expect(await run(scriptStream([{ type: "finish", kind: "error" }]).stream)).toBe("llm 调用失败"); // 带内无文案兜底
  });

  it("⑧ history 零触碰（零落盘）：只读一次快照、事件数组逐字节不变、请求 messages 是新数组", async () => {
    const events = [userEv(1, "主线"), asstEv(2, "回答")];
    const snapshot = JSON.parse(JSON.stringify(events)) as SessionEvent[];
    const h = stubH(events);
    const s = scriptStream([{ type: "text/delta", text: "侧答" }, { type: "finish", kind: "stop" }]);
    const run = openBtw(undefined, { getH: () => h as unknown as Harness, llmStream: s.stream }, "q");
    await run.done;
    expect(h.calls).toBe(1); // 一次只读快照（调用瞬间——§七 快照语义）
    expect(events).toEqual(snapshot); // deriveMessages 纯函数——事件镜像逐字节不变
    expect(s.reqs[0]!.messages).not.toBe(events); // 投影是新数组
    expect(s.reqs[0]!.messages.at(-1)).toMatchObject({ role: "user", content: [{ kind: "text", text: "q" }] });
  });

  it("⑨ chunk 聚合：只收 text/delta——reasoning/usage/server-search 不进答案文", async () => {
    const s = scriptStream([
      { type: "reasoning/delta", text: "思考中" },
      { type: "text/delta", text: "一" },
      { type: "usage", input: 10, output: 2 },
      { type: "server-search", hits: [] },
      { type: "text/delta", text: "二" },
      { type: "finish", kind: "stop" },
    ]);
    const run = openBtw(undefined, deps(s.stream), "q");
    await run.done;
    expect(run.slot).toMatchObject({ phase: "answer", text: "一二" });
  });
});

describe("/btw 边界（m5-btw T5）", () => {
  it("空会话首问（主会话还没有任何消息）：history 为空 → messages 只有问题一条——侧问自然退化为无上下文快问", async () => {
    const r = await buildBtwRequest(stubH([]), "随便问点啥");
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ role: "user", content: [{ kind: "text", text: "随便问点啥" }] });
    expect(r.system).toContain("side-question assistant"); // system 侧照常全量（话术仍在）
  });
});

/** 轮询等待（升级档用；模块层——describe 内副本触发 consistent-function-scoping）。 */
const btwWaitFor = async (pred: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
};

/** 分段流（升级档用；模块层同因）：先吐思考+首段正文后挂起（可断言中段），放行后吐尾段+finish。 */
const btwStepStream = (): { stream: (req: BtwStreamReq) => AsyncIterable<Chunk>; release: () => void } => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return {
    stream: () => (async function* () {
      yield { type: "reasoning/delta", text: "思考一\n思考二\n思考三" };
      yield { type: "text/delta", text: "答" };
      await gate;
      yield { type: "text/delta", text: "案" };
      yield { type: "finish", kind: "stop" };
    })(),
    release,
  };
};

describe("/btw 流式与思考预览（m5-btw 升级档——D13 一秒一跳 + kimi thinking 预览）", () => {
  it("① 一秒一跳 + 思考预览：answering 中段读到流式正文与思考末两行（首行被顶掉）；answer 态思考整块退役", async () => {
    const s = btwStepStream();
    const run = openBtw(undefined, deps(s.stream), "q");
    await btwWaitFor(() => run.slot.text === "答"); // 挂起在中段：正文一字、思考三行已入槽
    const mid = renderBtwView(run.slot, 40);
    expect(stripAnsi(mid)).toContain("答"); // 流式正文已现（chunk 边收边写——live 每秒读槽）
    expect(stripAnsi(mid)).toContain("思考二");
    expect(stripAnsi(mid)).toContain("思考三"); // 预览 = 思考末两行
    expect(stripAnsi(mid)).not.toContain("思考一"); // 首行被顶掉（防长思考把正文顶出屏）
    expect(stripAnsi(mid)).toMatch(/回答中 · \d+s/); // 正文已到 → 回答中尾行
    s.release();
    await run.done;
    expect(run.slot).toMatchObject({ phase: "answer", text: "答案" });
    const done = renderBtwView(run.slot, 40);
    expect(stripAnsi(done)).toContain("答案");
    expect(stripAnsi(done)).not.toContain("思考三"); // answer 态思考预览退役——只留答案
  });

  it("② 纯思考期尾行标「思考中」：只有 reasoning 无正文时；思考不进答案文（text 只收 text/delta）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const stream = (): AsyncIterable<Chunk> => (async function* () {
      yield { type: "reasoning/delta", text: "只有思考" };
      await gate;
      yield { type: "finish", kind: "stop" }; // 零正文完成（防御形态——text 空）
    })();
    const run = openBtw(undefined, { getH: () => stubH([]) as unknown as Harness, llmStream: () => stream() }, "q");
    await btwWaitFor(() => (run.slot.thinking ?? "") !== "");
    const think = renderBtwView(run.slot, 40);
    expect(stripAnsi(think)).toContain("只有思考");
    expect(stripAnsi(think)).toMatch(/思考中 · \d+s/); // 无正文 → 思考中尾行
    release();
    await run.done;
    expect(run.slot).toMatchObject({ phase: "answer", text: "" }); // 思考没混进答案文
    expect(run.slot.thinking).toBe("只有思考"); // 槽里留档（仅 answering 期显示用）
  });
});

describe("/btw 窗接线（m5-btw T3）", () => {
  it("① live 三态输出：开窗即 answering 转盘+秒数 → answer 正文行 → error 红字一行（同一闭包每帧现算）", async () => {
    const { app, calls } = stubApp();
    const g = gateStream();
    const run = openBtw(app, { ...bareDeps(), llmStream: g.stream }, "为什么这里用 unsafe");
    expect(calls[0]).toMatchObject({ title: "侧问 · 为什么这里用 unsafe" });
    expect(calls[0]!.opts.layout).toBe("dock"); // 贴输入框上缘（TUI 三家共识形态，D3）
    expect(calls[0]!.opts.live).toBeDefined(); // 三态窗全挂 live
    expect(stripAnsi(calls[0]!.opts.live!())).toMatch(/回答中 · \d+s/);
    expect(stripAnsi(calls[0]!.text)).toMatch(/回答中 · \d+s/); // 首帧即转盘行，不等 1s tick
    g.release([{ type: "text/delta", text: "因为跨 FFI 边界" }, { type: "finish", kind: "stop" }]);
    await run.done;
    const answered = calls[0]!.opts.live!();
    expect(stripAnsi(answered)).not.toContain("回答中");
    expect(stripAnsi(answered)).toContain("因为跨 FFI 边界"); // 同一闭包翻成答案
    // error 态：同一窗正文区换红字原因行
    const err = openBtw(app, { ...bareDeps(), llmStream: throwStream(new Error("端点 401")) }, "第二问");
    await err.done;
    expect(stripAnsi(calls[1]!.opts.live!())).toContain("端点 401");
  });

  it("② renderMarkdown 行形态：md 源码不透传（粗体/列表过同源公共口）、长段按 dock 内容宽折行", () => {
    const slot: BtwSlot = { question: "q", phase: "answer", text: "**粗体** 与列表：\n\n- 甲项\n- 乙项", startedAt: 0 };
    const out = renderBtwView(slot, 20);
    expect(stripAnsi(out)).toContain("粗体");
    expect(stripAnsi(out)).toContain("甲项");
    expect(out).not.toContain("**"); // md 标记不透传——流区同源管线（mdpipe renderMarkdown）
    const long = renderBtwView({ question: "q", phase: "answer", text: "一".repeat(50), startedAt: 0 }, 20);
    expect(stripAnsi(long).split("\n").length).toBeGreaterThan(1); // 20 宽下 50 字必折行
  });

  it("③ 关窗后槽保留：answer 归档不随窗消失——reopenBtw 重开静态窗（无 live 不重跑）；行模式经 out 回显", async () => {
    const run = openBtw(undefined, deps(scriptStream([{ type: "text/delta", text: "回看正文" }, { type: "finish", kind: "stop" }]).stream), "回看题");
    await run.done; // 窗（若有）关掉后归档仍在
    const { app, calls } = stubApp();
    expect(reopenBtw(app, bareDeps())).toBe(true);
    expect(calls[0]).toMatchObject({ title: "侧问 · 回看题" });
    expect(calls[0]!.opts.layout).toBe("dock"); // 回看同 dock 形态
    expect(calls[0]!.opts.live).toBeUndefined(); // 静态答案不重跑
    expect(stripAnsi(calls[0]!.text)).toContain("回看正文");
    const outs: string[] = [];
    expect(reopenBtw(undefined, { ...bareDeps(), out: (s) => outs.push(s) })).toBe(true);
    expect(outs[0]).toContain("回看题");
    expect(outs[0]).toContain("回看正文");
  });
});
