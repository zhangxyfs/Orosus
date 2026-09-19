import type { Chunk } from "@orosus/contracts/provider";
import type { Harness, SessionEvent } from "@orosus/core";
import { renderMarkdown } from "./markdown.ts";

const DIM = "\x1b[2m";
const RESET = "\x1b[22m";

/** 渲染状态：reasoning 以大量小 delta 到达，块的开/闭需跨事件跟踪（思考 → 正文/工具的边界）。 */
export interface RenderState {
  inReasoning: boolean;
}

export function createRenderState(): RenderState {
  return { inReasoning: false };
}

const closeReasoning = (state: RenderState): string => {
  if (!state.inReasoning) return "";
  state.inReasoning = false;
  return `${RESET}\n`;
};

/** 单 Chunk → 终端文案（M4-1 T5/D45：从原 assistant/chunk 事件分支迁来——断流后 chunk 经
 *  liveChunks 旁路到达，不再落日志）。思考（GLM/DeepSeek 方言 reasoning_content、Anthropic
 *  thinking_delta）以暗色 [思考] 块显示，首个正文/工具/结束闭块；401/403/429 带排查提示（走查缺陷③）。 */
export function renderChunk(c: Chunk, state: RenderState): string {
  if (c.type === "reasoning/delta") {
    if (!state.inReasoning) {
      state.inReasoning = true;
      return `\n${DIM}[思考] ${c.text}`;
    }
    return c.text;
  }
  if (c.type === "text/delta") return closeReasoning(state) + c.text;
  if (c.type === "finish" && c.kind === "error") {
    // 401/403 提示（模型发现 T5）：校验用输入值、运行用合并链（显式 env > process.env > secrets.env）
    // ——同名环境变量覆盖刚写入的 secrets 是最常见根因，给用户排查方向
    const msg = c.errorMessage ?? "";
    const hint = /HTTP 40[13]/.test(msg)
      ? "\n[提示] 密钥被拒——若刚更新过 secrets.env，检查同名环境变量是否覆盖（优先级：显式 env > process.env > secrets.env）\n"
      : /HTTP 429/.test(msg)
        ? "\n[提示] 429 限流或配额不足——错误体含 1113（余额不足或无可用资源包）时，检查套餐窗口配额是否用尽、模型是否在套餐覆盖列表\n"
        : "";
    return `${closeReasoning(state)}\n[模型错误] ${msg}${hint}`;
  }
  return "";
}

/** 单事件 → 终端文案（完成事件面——T5 断流后 assistant/chunk 不在此列）。
 *  压缩/裁剪对用户可见（三轮 P1：此前零渲染）；四家参考均有可见提示。 */
export function renderEvent(e: SessionEvent, state: RenderState): string {
  if (e.type === "tool/call") return `${closeReasoning(state)}\n[tool] ${String(e.name)} ${JSON.stringify(e.args)}\n`;
  if (e.type === "tool/result") return `[tool ${e.isError === true ? "错误" : "完成"}]\n`;
  if (e.type === "turn/compaction") return `\n[已压缩：前缀 ${Number(e.droppedCount ?? 0)} 条 → 摘要（/summary 查看）]\n`;
  if (e.type === "turn/prune") return `\n[已裁剪 ${Array.isArray(e.prunes) ? (e.prunes as unknown[]).length : 0} 个超长工具结果（原文保留在会话文件中）]\n`;
  if (e.type === "turn/end") return `${closeReasoning(state)}\n`;
  return "";
}

/** 历史回显（B9 走查补，2026-09-19：resume 后屏幕上什么都没有——用户以为历史没记录）：
 *  存量事件 → 文案行。user 以 `> ` 呈现（与 REPL 输入形态一致）、assistant 只画正文块
 *  （reasoning 属审计面，回显不刷屏）、tool/call 一行带过（result 可能巨大不入屏）。
 *  单行超长截断（走查：巨回答单行刷屏）——完整原文永远在会话文件。 */
const HISTORY_LINE_MAX = 2000;

export function renderHistoryLines(events: SessionEvent[]): string[] {
  const out: string[] = [];
  const textBlocks = (e: SessionEvent): string =>
    ((e.content ?? []) as { kind?: string; text?: string }[])
      .filter((p) => p.kind === "text")
      .map((p) => p.text ?? "")
      .join("");
  const cap = (s: string): string => (s.length > HISTORY_LINE_MAX ? `${s.slice(0, HISTORY_LINE_MAX)}…（超长截断——完整原文在会话文件）` : s);
  for (const e of events) {
    if (e.type === "user/message") {
      const text = textBlocks(e);
      if (text !== "") out.push(`> ${cap(text)}`);
    } else if (e.type === "assistant/message") {
      const text = textBlocks(e);
      if (text !== "") out.push(renderMarkdown(cap(text)), ""); // M4-2 T13：回显面 markdown 第 1 层（流式期间原样）
    } else if (e.type === "tool/call") {
      out.push(`  [tool] ${String(e.name)}`);
    } else if (e.type === "turn/compaction") {
      // 压缩点回显（M4-2.5 T4——压缩调研 §4.2：resume 后压缩点完全隐形是六家独一份的偏差）
      out.push(`  [已压缩：前缀 ${Number((e as { droppedCount?: number }).droppedCount ?? 0)} 条 → 摘要（/summary 查看）]`);
    }
  }
  return out;
}

/** 回显分页（走查：历史太大全量回显刷爆终端）：尾页优先——最新对话最先可见，
 *  hiddenBefore = 前面还有多少行（TTY 下由宿主翻页消费；非交互只出尾页）。 */
export function historyPage(lines: string[], page = 30): { shown: string[]; hiddenBefore: number } {
  if (lines.length <= page) return { shown: lines, hiddenBefore: 0 };
  return { shown: lines.slice(lines.length - page), hiddenBefore: lines.length - page };
}

/** 挂接渲染（main.ts 的接线面，M4-1 T5 双订阅）：实时 Chunk 走 liveChunks 旁路 → renderChunk；
 *  完成事件走 events() → renderEvent（onEvent 供 /fork 记 lastEventId——chunk 无事件 id，不受影响）。
 *  两路共享同一 RenderState（思考块的闭合可来自任一路：正文 delta 或 tool/call 事件）。 */
export function attachRender(h: Harness, write: (s: string) => void, onEvent?: (id: string) => void): void {
  const state = createRenderState();
  void (async () => {
    for await (const c of h.liveChunks()) {
      const out = renderChunk(c, state);
      if (out !== "") write(out);
    }
  })();
  void (async () => {
    for await (const e of h.events()) {
      onEvent?.(e.id);
      const out = renderEvent(e, state);
      if (out !== "") write(out);
    }
  })();
}
