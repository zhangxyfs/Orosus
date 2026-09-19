import { describe, it, expect } from "vitest";
import type { Chunk } from "@orosus/contracts/provider";
import type { SessionEvent } from "@orosus/core";
import { createRenderState, renderChunk, renderEvent, renderHistoryLines, historyPage } from "./render.ts";

// M4-1 T5/D45：chunk 渲染迁 renderChunk（断流后 chunk 经 liveChunks 旁路到达，不再落日志/事件流）；
// 完成事件面仍走 renderEvent——两路共享 RenderState。
const chunk = (c: unknown): Chunk => c as Chunk;
const event = (type: string, fields: Record<string, unknown> = {}): SessionEvent =>
  ({ id: "e1", sessionId: "s", ts: 0, seq: 1, type, ...fields }) as unknown as SessionEvent;

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
    ]);
    expect(lines).toEqual(["> 你好", "答", "", "  [tool] tool-fs__read"]);
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
    const lines = renderHistoryLines([ev2("assistant/message", { content: [{ kind: "text", text: huge }] })]);
    expect(lines[0]!.length).toBeLessThan(2100);
    expect(lines[0]).toContain("完整原文在会话文件");
  });
});
