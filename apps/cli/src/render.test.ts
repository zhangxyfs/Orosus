import { describe, it, expect } from "vitest";
import type { Chunk } from "@orosus/contracts/provider";
import type { Harness, SessionEvent } from "@orosus/core";
import { createRenderState, renderChunk, renderEvent, renderHistoryLines, historyPage, attachRender, errorMessageText, registerToolLabels, toolDisplayName, toolCallLine } from "./render.ts";

// M4-1 T5/D45：chunk 渲染迁 renderChunk（断流后 chunk 经 liveChunks 旁路到达，不再落日志/事件流）；
// 完成事件面仍走 renderEvent——两路共享 RenderState。
const chunk = (c: unknown): Chunk => c as Chunk;
const event = (type: string, fields: Record<string, unknown> = {}): SessionEvent =>
  ({ id: "e1", sessionId: "s", ts: 0, seq: 1, type, ...fields }) as unknown as SessionEvent;

// 模型错误 toast 化批（attachRender onError 钉用）：liveChunks 旁路假源 + finish 变体铸型
const fakeH = (chunks: unknown[]) =>
  ({
    liveChunks: async function* () { for (const c of chunks) yield c; },
    events: async function* () {},
  }) as unknown as Harness;
const finishErr = (errorMessage: string) => ({ type: "finish", kind: "error", errorMessage }) as Extract<Chunk, { type: "finish" }>;

const DIM = "\x1b[2m";
const RESET = "\x1b[22m";

describe("reasoning 块渲染（思考过程可见——T5 后经 renderChunk/liveChunks）", () => {
  it("① 首个 reasoning/delta 开块：标记 + 暗色起始", () => {
    const st = createRenderState();
    const out = renderChunk(chunk({ type: "reasoning/delta", text: "让我想想" }), st);
    expect(out).toBe(`\n${DIM}[思考] 让我想想`);
    expect(st.inReasoning).toBe(true);
  });

  it("② 后续 reasoning/delta 续流：裸文本（块已开，暗色延续）", () => {
    const st = createRenderState();
    renderChunk(chunk({ type: "reasoning/delta", text: "a" }), st);
    expect(renderChunk(chunk({ type: "reasoning/delta", text: "b" }), st)).toBe("b");
  });

  it("③ 首个 text/delta 闭块：复位色 + 换行后接正文", () => {
    const st = createRenderState();
    renderChunk(chunk({ type: "reasoning/delta", text: "想" }), st);
    expect(renderChunk(chunk({ type: "text/delta", text: "答" }), st)).toBe(`${RESET}\n答`);
    expect(st.inReasoning).toBe(false);
  });

  it("④ tool/call 事件闭块（纯思考 + 工具回合——事件路与 chunk 路共享状态）", () => {
    const st = createRenderState();
    renderChunk(chunk({ type: "reasoning/delta", text: "想" }), st);
    expect(renderEvent(event("tool/call", { name: "read", args: {} }), st).startsWith(`${RESET}\n`)).toBe(true);
    expect(st.inReasoning).toBe(false);
  });

  it("⑤ turn/end 闭块（无正文的思考收尾不留悬空色码）", () => {
    const st = createRenderState();
    renderChunk(chunk({ type: "reasoning/delta", text: "想" }), st);
    expect(renderEvent(event("turn/end"), st)).toBe(`${RESET}\n\n`);
  });

  it("⑥ finish error 闭块后再出错误文案", () => {
    const st = createRenderState();
    renderChunk(chunk({ type: "reasoning/delta", text: "想" }), st);
    const out = renderChunk(chunk({ type: "finish", kind: "error", errorMessage: "HTTP 500" }), st);
    expect(out.startsWith(`${RESET}\n\n[模型错误] HTTP 500`)).toBe(true);
  });

  it("⑦ 未开块时正文渲染不带色码；usage chunk 静默（回归：原行为不变）", () => {
    const st = createRenderState();
    expect(renderChunk(chunk({ type: "text/delta", text: "hi" }), st)).toBe("hi");
    expect(renderChunk(chunk({ type: "usage", input: 1, output: 2 }), st)).toBe("");
  });

  it("⑧ HTTP 429 提示配额/余额排查方向（智谱 1113）；500 无提示", () => {
    const st = createRenderState();
    const out429 = renderChunk(chunk({ type: "finish", kind: "error", errorMessage: 'HTTP 429：{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}' }), st);
    expect(out429).toContain("套餐窗口配额");
    const st2 = createRenderState();
    expect(renderChunk(chunk({ type: "finish", kind: "error", errorMessage: "HTTP 500：boom" }), st2)).not.toContain("套餐窗口配额");
  });

  it("⑨ 事件面无 assistant/chunk 分支（断流钉子——renderEvent 对 chunk 事件返回空）", () => {
    const st = createRenderState();
    expect(renderEvent(event("assistant/chunk", { chunk: { type: "text/delta", text: "x" } }), st)).toBe("");
  });
});

describe("历史回显（B9 走查补：resume 后屏幕空白——用户以为历史没记录）", () => {
  const ev = (type: string, fields: Record<string, unknown> = {}): SessionEvent =>
    ({ id: "e1", sessionId: "s", ts: 0, seq: 1, type, ...fields }) as unknown as SessionEvent;

  it("① user 以 > 呈现、assistant 只画正文、reasoning 不刷屏、tool 一行带过、result 不入屏", () => {
    const lines = renderHistoryLines([
      ev("session/header"),
      ev("user/message", { content: [{ kind: "text", text: "你好" }] }),
      ev("assistant/message", { content: [{ kind: "reasoning", text: "长篇思考不该出现在回显" }, { kind: "text", text: "答" }] }),
      ev("tool/call", { name: "tool-fs__read" }),
      ev("tool/result", { output: "巨大输出不入屏" }),
    ], 80);
    expect(lines).toEqual(["> 你好", "答", "", "  Used Read"]); // F5 五轮①：工具行 kimi 形态（无名参 → 只剩显示名）
  });
});

describe("回显分页（走查：巨量历史全量回显刷爆终端）", () => {
  const ev2 = (type: string, fields: Record<string, unknown> = {}): SessionEvent =>
    ({ id: "e1", sessionId: "s", ts: 0, seq: 1, type, ...fields }) as unknown as SessionEvent;
  it("① historyPage：不超页全显示；超页取尾页并报 hiddenBefore", () => {
    expect(historyPage(["a", "b", "c"], 30)).toEqual({ shown: ["a", "b", "c"], hiddenBefore: 0 });
    const lines = Array.from({ length: 75 }, (_, i) => `L${i}`);
    const p = historyPage(lines, 30);
    expect(p.hiddenBefore).toBe(45);
    expect(p.shown).toEqual(lines.slice(45));
  });

  it("② renderHistoryLines 单行截断：超 2000 字符的巨回答截断并注明原文位置", () => {
    const huge = "x".repeat(3000);
    const lines = renderHistoryLines([ev2("assistant/message", { content: [{ kind: "text", text: huge }] })], 80);
    expect(lines[0]!.length).toBeLessThan(2100);
    expect(lines.join(String.fromCharCode(10))).toContain("完整原文在会话文件"); // 折行后注记在尾部——语义不变（F2 新管线多行输出）
  });
});

describe("压缩点渲染可见（M4-2.5 T4——压缩调研 P2：实时+回显两处）", () => {
  it("① renderEvent turn/compaction → 实时一行，含 Ctrl+O 指针（/summary 退役后）", () => {
    const st = createRenderState();
    const out = renderEvent(event("turn/compaction", { summary: "s", keepFrom: 4, droppedCount: 7 }), st);
    expect(out).toContain("已压缩");
    expect(out).toContain("7");
    expect(out).toContain("Ctrl+O");
  });

  it("② renderHistoryLines turn/compaction → 回显一行（resume 后压缩点不再隐形）", () => {
    const lines = renderHistoryLines([
      event("user/message", { content: [{ kind: "text", text: "问" }] }),
      event("turn/compaction", { summary: "s", keepFrom: 1, droppedCount: 3 }),
    ], 80);
    expect(lines.some((l) => l.includes("已压缩") && l.includes("Ctrl+O"))).toBe(true);
  });
});

describe("回显图痕（M4-2.5 T5——image part 在 renderHistoryLines 可见）", () => {
  it("含 image part 的 user/message → [图片] 标记行（resume 回显不零痕）", () => {
    const lines = renderHistoryLines([
      event("user/message", { content: [{ kind: "text", text: "这是什么" }, { kind: "image", path: "C:/tmp/p.png", mimeType: "image/png" }] }),
    ], 80);
    expect(lines.some((l) => l.includes("这是什么") && l.includes("[图片]"))).toBe(true);
    const imgOnly = renderHistoryLines([
      event("user/message", { content: [{ kind: "image", path: "C:/tmp/q.png", mimeType: "image/png" }] }),
    ], 80);
    expect(imgOnly.some((l) => l.includes("[图片]"))).toBe(true);
  });
});

// ——模型错误 toast 化（2026-09-23 用户拍板）：finish error 不再进活动流区，TTY 走 onError toast 口
describe("模型错误 toast 化（errorMessageText + attachRender onError）", () => {
  it("① errorMessageText：无标签纯文本，401/429 排查提示跟随、普通错误不带", () => {
    expect(errorMessageText(finishErr("HTTP 500 boom"))).toBe("模型错误：HTTP 500 boom");
    expect(errorMessageText(finishErr("HTTP 401 x"))).toContain("\n提示：密钥被拒");
    expect(errorMessageText(finishErr("HTTP 429 x"))).toContain("\n提示：429 限流");
  });

  it("② attachRender TTY：finish error 走 onError、不进 activity（错误体退出流区）", async () => {
    const toasted: string[] = [];
    let activityErr: string | undefined;
    attachRender(fakeH([{ type: "finish", kind: "error", errorMessage: "HTTP 401 x" }]), {
      write: () => {},
      activity: (c) => { if (c.text.includes("模型错误")) activityErr = c.text; },
      onError: (t) => toasted.push(t),
    });
    await new Promise((r) => setTimeout(r, 20)); // 附着即异步消费旁路流
    expect(toasted).toHaveLength(1);
    expect(toasted[0]!).toContain("模型错误：HTTP 401 x");
    expect(toasted[0]!).toContain("提示：密钥被拒");
    expect(activityErr).toBeUndefined();
  });

  it("③ 缺 onError（非 TTY/--print 兼容面）→ 回落 activity 旧管道形（[模型错误] 标签在）", async () => {
    const act: string[] = [];
    attachRender(fakeH([{ type: "finish", kind: "error", errorMessage: "HTTP 500" }]), {
      write: () => {},
      activity: (c) => act.push(c.text),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(act.join("")).toContain("[模型错误] HTTP 500");
  });
});

describe("工具显示名 label（2026-09-24 用户拍板——Search→Web Search 可读化）", () => {
  it("① 喂入 label 后 toolDisplayName/toolCallLine 用 label；不喂回落剥前缀（旧行为零漂移）", () => {
    registerToolLabels([{ name: "tool-web__search", label: "Web Search" }]);
    expect(toolDisplayName("tool-web__search")).toBe("Web Search");
    expect(toolCallLine("tool-web__search", { query: "北京天气" }, process.cwd())).toBe("● Using Web Search (北京天气)");
    expect(toolDisplayName("tool-fs__read")).toBe("Read"); // 无 label 工具照旧
    registerToolLabels([]); // 清场——全局表不串扰其他用例
    expect(toolDisplayName("tool-web__search")).toBe("Search");
  });

  it("② reload 重喂语义：带 label 收录、label 摘除后回落（同位换模块生效）", () => {
    registerToolLabels([{ name: "m__t", label: "My Tool" }]);
    expect(toolDisplayName("m__t")).toBe("My Tool");
    registerToolLabels([{ name: "m__t" }]); // 重喂时无 label = 摘除
    expect(toolDisplayName("m__t")).toBe("T");
    registerToolLabels([]);
  });

  it("③ 历史回显行带 label（renderHistoryLines 同走 toolCallLine）", () => {
    registerToolLabels([{ name: "tool-web__fetch", label: "Web Fetch" }]);
    const lines = renderHistoryLines([event("tool/call", { name: "tool-web__fetch", args: { url: "https://e.com" } })], 80);
    expect(lines[0]).toContain("Used Web Fetch"); // url 不在关键参数提取面——行尾无参数属正常形态
    registerToolLabels([]);
  });
});
