import { relative } from "node:path";
import type { Chunk } from "@orosus/contracts/provider";
import type { Harness, SessionEvent } from "@orosus/core";
import { renderMarkdown } from "./mdpipe.ts";
import type { StreamChunk } from "./tui/streamview.ts";

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

// 401/403/429 排查提示正文（模型发现 T5 走查缺陷③）：校验用输入值、运行用合并链（显式 env > process.env > secrets.env）
// ——同名环境变量覆盖刚写入的 secrets 是最常见根因，给用户排查方向。管道形带 [提示] 标签、toast 形裸文案（两形共用正文防漂移）
const HINT_401 = "密钥被拒——若刚更新过 secrets.env，检查同名环境变量是否覆盖（优先级：显式 env > process.env > secrets.env）";
const HINT_429 = "429 限流或配额不足——错误体含 1113（余额不足或无可用资源包）时，检查套餐窗口配额是否用尽、模型是否在套餐覆盖列表";

/** 模型错误 → toast 文案（2026-09-23 用户拍板：模型错误不再落流区）：无标签纯文本，排查提示跟随。
 *  全屏浮动 toast（3 行封顶——超长错误体尾部让位）/ 行模式 console 单行同文案。 */
export function errorMessageText(c: Extract<Chunk, { type: "finish" }>): string {
  const msg = c.errorMessage ?? "";
  const hint = /HTTP 40[13]/.test(msg) ? `\n提示：${HINT_401}` : /HTTP 429/.test(msg) ? `\n提示：${HINT_429}` : "";
  return `模型错误：${msg}${hint}`;
}

/** 单 Chunk → 终端文案（M4-1 T5/D45：从原 assistant/chunk 事件分支迁来——断流后 chunk 经
 *  liveChunks 旁路到达，不再落日志）。思考（GLM/DeepSeek 方言 reasoning_content、Anthropic
 *  thinking_delta）以暗色 [思考] 块显示，首个正文/工具/结束闭块；401/403/429 带排查提示（走查缺陷③）。
 *  注：finish kind=error 的本形仅供非 TTY/--print 管道（byte 回归钉 render.test⑥）；TTY 已改走 attachRender onError。 */
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
    const msg = c.errorMessage ?? "";
    const hint = /HTTP 40[13]/.test(msg) ? `\n[提示] ${HINT_401}\n` : /HTTP 429/.test(msg) ? `\n[提示] ${HINT_429}\n` : "";
    return `${closeReasoning(state)}\n[模型错误] ${msg}${hint}`;
  }
  return "";
}

// ---------- 工具行（F5 五轮①——kimi-code 形态调研落地：● Using/Used Tool (关键参数) · N 行） ----------
// Using → 结果到达后由 DocModel 原位合并成 Used + 行数 chip（行模式转独立 ↳ 行）。

/** 工具显示名：tool-fs__read → Read；无 __ 前缀整体首字母大写。 */
export function toolDisplayName(name: string): string {
  const tail = name.includes("__") ? name.split("__").pop()! : name;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

const capArg = (s: string, max = 60): string => {
  const t = s.replace(/\\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 12)}…${t.slice(-10)}`;
};

/** 关键参数：path/file/pattern/command/query 优先；工作区内相对路径、区外全路径（用户口径）。 */
export function toolKeyArg(args: Record<string, unknown> | undefined, cwd: string): string {
  const raw =
    typeof args?.path === "string" ? args.path
    : typeof args?.file === "string" ? args.file
    : typeof args?.pattern === "string" ? args.pattern
    : typeof args?.command === "string" ? args.command
    : typeof args?.query === "string" ? args.query
    : undefined;
  if (raw === undefined) return "";
  if (/[\\/]/.test(raw)) {
    const rel = relative(cwd, raw);
    if (rel !== "" && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel)) return capArg(rel.replace(/\\/g, "/"));
    return capArg(raw.replace(/\\/g, "/"));
  }
  return capArg(raw);
}

/** tool/call 行（纯文本——着色/原位合并归消费面）。 */
export function toolCallLine(name: string, args: Record<string, unknown> | undefined, cwd: string): string {
  const arg = toolKeyArg(args, cwd);
  return `● Using ${toolDisplayName(name)}${arg === "" ? "" : ` (${arg})`}`;
}

/** 原位合并哨兵（DocModel 挂到对应 ● 行；行模式消费面转独立行）。 */
export const TOOL_MERGE = "\x1d";
export function toolResultChip(output: unknown, isError: unknown): string {
  if (isError === true) return TOOL_MERGE + "失败";
  const text = typeof output === "string" ? output : String(output ?? "");
  let n = 0;
  for (const l of text.split("\n")) if (l.trim().length > 0) n++;
  return TOOL_MERGE + `${n} 行`;
}

/** 单事件 → 终端文案（完成事件面——T5 断流后 assistant/chunk 不在此列）。
 *  压缩/裁剪对用户可见（三轮 P1：此前零渲染）；四家参考均有可见提示。 */
export function renderEvent(e: SessionEvent, state: RenderState): string {
  if (e.type === "tool/call") return `${closeReasoning(state)}\n${toolCallLine(String(e.name), e.args as Record<string, unknown> | undefined, process.cwd())}\n`;
  if (e.type === "tool/result") return `${toolResultChip(e.output, e.isError)}\n`;
  if (e.type === "turn/compaction") return `\n[已压缩：${Number(e.droppedCount ?? 0)} 条历史 → 摘要（Ctrl+O 查看）]\n`;
  if (e.type === "turn/prune") return `\n[已裁剪 ${Array.isArray(e.prunes) ? (e.prunes as unknown[]).length : 0} 个超长工具结果（原文保留在会话文件中）]\n`;
  if (e.type === "turn/end") return `${closeReasoning(state)}\n`;
  return "";
}

/** 历史回显（B9 走查补，2026-09-19：resume 后屏幕上什么都没有——用户以为历史没记录）：
 *  存量事件 → 文案行。user 以 `> ` 呈现（与 REPL 输入形态一致）、assistant 只画正文块
 *  （reasoning 属审计面，回显不刷屏）、tool/call 一行带过（result 可能巨大不入屏）。
 *  单行超长截断（走查：巨回答单行刷屏）——完整原文永远在会话文件。 */
const HISTORY_LINE_MAX = 2000;

export function renderHistoryLines(events: SessionEvent[], width: number): string[] {
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
      const imgs = ((e.content ?? []) as { kind?: string }[]).filter((p) => p.kind === "image").length;
      // image part 图痕（M4-2.5 T5）：回显不零痕——[图片] 标记随 user 行（纯图消息也有一行）
      const line = `${text}${imgs > 0 ? `${text !== "" ? " " : ""}[图片]${imgs > 1 ? `×${imgs}` : ""}` : ""}`;
      if (line !== "") out.push(`> ${cap(line)}`);
    } else if (e.type === "assistant/message") {
      const text = textBlocks(e);
      if (text !== "") {
        // 回显面 markdown 新管线（F2——mdpipe 替换 markdown.ts 第 1 层）；
        // 段落渲染自带末尾空行——回显行序与旧第 1 层同形（单空行分隔）故剥尾
        const md = renderMarkdown(cap(text), width);
        while (md.length > 0 && md[md.length - 1] === "") md.pop();
        out.push(...md, "");
      }
    } else if (e.type === "tool/call") {
      out.push(`  ${toolCallLine(String(e.name), e.args as Record<string, unknown> | undefined, process.cwd()).replace("● Using ", "Used ")}`);
    } else if (e.type === "turn/compaction") {
      // 压缩点回显（M4-2.5 T4——压缩调研 §4.2：resume 后压缩点完全隐形是六家独一份的偏差）
      out.push(`  [已压缩：${Number((e as { droppedCount?: number }).droppedCount ?? 0)} 条历史 → 摘要（Ctrl+O 查看）]`);
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
 *  完成事件走 events() → renderEvent（onEvent 供 /fork 记 lastEventId 与 streamview 的 turn/end 判定——
 *  chunk 无事件 id，不受影响）。两路共享同一 RenderState（思考块的闭合可来自任一路）。
 *  双写面（T4/v1.8；F2 升级）：chunk 路 TTY 接 io.activity——**结构化 StreamChunk**（kind + 原文，
 *  渲染形态由 streamview/mdpipe 负责——F2 新管线）；activity 缺省回落 renderChunk 旧形态（非 TTY
 *  /--print 零变化）。事件路输出接 io.write（工具行/压缩行直写——混入重绘区会固化序错乱）。 */
export function attachRender(
  h: Harness,
  io: {
    write(s: string): void;
    activity?(c: StreamChunk): void;
    /** 工具调用结构化口（2026-09-23 走查批）：全屏 DocModel 提供时 tool/call 不再压成一行文本——
     *  args 留存供 diff/失败体渲染（Alt+O 折叠）；缺省 = 旧文本形态（行模式/--print 零变化）。 */
    toolCall?(name: string, args: Record<string, unknown> | undefined): void;
    toolResult?(output: unknown, isError: unknown): void;
    /** 模型错误 toast 口（2026-09-23 用户拍板）：finish kind=error 不再进活动流区——TTY 下改走此口
     *  （全屏浮动 toast / 行模式单行，文案 errorMessageText）；缺省回落 renderChunk 旧管道形（--print）。 */
    onError?(text: string): void;
  },
  onEvent?: (e: SessionEvent) => void,
): void {
  const state = createRenderState();
  void (async () => {
    for await (const c of h.liveChunks()) {
      if (io.activity !== undefined) {
        // 结构化活动面（F2）：kind + 原文——思考/正文边界与着色由 streamview 负责
        if (c.type === "reasoning/delta") io.activity({ kind: "reasoning", text: c.text });
        else if (c.type === "text/delta") io.activity({ kind: "text", text: c.text });
        else if (c.type === "finish" && c.kind === "error") {
          // 模型错误 toast 化（2026-09-23 用户拍板）：TTY 走 onError（全屏 toast/行模式单行），
          // 错误体不进活动流区；无 toast 口（兼容面/测试）回落旧 activity 形
          if (io.onError !== undefined) io.onError(errorMessageText(c));
          else io.activity({ kind: "text", text: renderChunk(c, createRenderState()) });
        }
        continue;
      }
      const out = renderChunk(c, state);
      if (out !== "") io.write(out);
    }
  })();
  void (async () => {
    for await (const e of h.events()) {
      onEvent?.(e);
      // 结构化工具口优先（全屏）：tool/call / tool/result 不走文本压行
      if (e.type === "tool/call" && io.toolCall !== undefined) {
        io.toolCall(String(e.name), e.args as Record<string, unknown> | undefined);
        continue;
      }
      if (e.type === "tool/result" && io.toolResult !== undefined) {
        io.toolResult(e.output, e.isError);
        continue;
      }
      const out = renderEvent(e, state);
      if (out !== "") io.write(out);
    }
  })();
}
