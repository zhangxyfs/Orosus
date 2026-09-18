import { describe, it, expect } from "vitest";
import type { SessionEvent } from "@orosus/core";
import { createRenderState, renderEvent } from "./render.ts";

const chunkEvent = (chunk: unknown): SessionEvent =>
  ({ id: "e1", sessionId: "s", ts: 0, seq: 1, type: "assistant/chunk", chunk }) as unknown as SessionEvent;
const event = (type: string, fields: Record<string, unknown> = {}): SessionEvent =>
  ({ id: "e1", sessionId: "s", ts: 0, seq: 1, type, ...fields }) as unknown as SessionEvent;

const DIM = "\x1b[2m";
const RESET = "\x1b[22m";

describe("reasoning 块渲染（思考过程可见）", () => {
  it("① 首个 reasoning/delta 开块：标记 + 暗色起始", () => {
    const st = createRenderState();
    const out = renderEvent(chunkEvent({ type: "reasoning/delta", text: "让我想想" }), st);
    expect(out).toBe(`\n${DIM}[思考] 让我想想`);
    expect(st.inReasoning).toBe(true);
  });

  it("② 后续 reasoning/delta 续流：裸文本（块已开，暗色延续）", () => {
    const st = createRenderState();
    renderEvent(chunkEvent({ type: "reasoning/delta", text: "a" }), st);
    expect(renderEvent(chunkEvent({ type: "reasoning/delta", text: "b" }), st)).toBe("b");
  });

  it("③ 首个 text/delta 闭块：复位色 + 换行后接正文", () => {
    const st = createRenderState();
    renderEvent(chunkEvent({ type: "reasoning/delta", text: "想" }), st);
    expect(renderEvent(chunkEvent({ type: "text/delta", text: "答" }), st)).toBe(`${RESET}\n答`);
    expect(st.inReasoning).toBe(false);
  });

  it("④ tool/call 闭块（纯思考 + 工具回合）", () => {
    const st = createRenderState();
    renderEvent(chunkEvent({ type: "reasoning/delta", text: "想" }), st);
    expect(renderEvent(event("tool/call", { name: "read", args: {} }), st).startsWith(`${RESET}\n`)).toBe(true);
    expect(st.inReasoning).toBe(false);
  });

  it("⑤ turn/end 闭块（无正文的思考收尾不留悬空色码）", () => {
    const st = createRenderState();
    renderEvent(chunkEvent({ type: "reasoning/delta", text: "想" }), st);
    expect(renderEvent(event("turn/end"), st)).toBe(`${RESET}\n\n`);
  });

  it("⑥ finish error 闭块后再出错误文案", () => {
    const st = createRenderState();
    renderEvent(chunkEvent({ type: "reasoning/delta", text: "想" }), st);
    const out = renderEvent(chunkEvent({ type: "finish", kind: "error", errorMessage: "HTTP 500" }), st);
    expect(out.startsWith(`${RESET}\n\n[模型错误] HTTP 500`)).toBe(true);
  });

  it("⑦ 未开块时正文/工具渲染不带色码（回归：原行为不变）", () => {
    const st = createRenderState();
    expect(renderEvent(chunkEvent({ type: "text/delta", text: "hi" }), st)).toBe("hi");
    expect(renderEvent(chunkEvent({ type: "usage", input: 1, output: 2 }), st)).toBe("");
  });

  it("⑧ HTTP 429 提示配额/余额排查方向（智谱 1113：余额不足或无可用资源包）；500 无提示", () => {
    const st = createRenderState();
    const out429 = renderEvent(chunkEvent({ type: "finish", kind: "error", errorMessage: 'HTTP 429：{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}' }), st);
    expect(out429).toContain("套餐窗口配额");
    const st2 = createRenderState();
    expect(renderEvent(chunkEvent({ type: "finish", kind: "error", errorMessage: "HTTP 500：boom" }), st2)).not.toContain("套餐窗口配额");
  });
});
