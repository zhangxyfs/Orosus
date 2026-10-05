/**
 * /btw 侧问命令本体（m5-btw，方案 docs/superpowers/plans/2026-10-03-m5-btw.md）：
 * 不打断主对话的旁路快问——promptSections+话术拼 system、deriveMessages(history)+问题消息拼
 * messages、经 h.llm() 零落盘直调（T1 暴露口，内建 tools:[]）。答案开 dock 窗（T3 接线）不进
 * 主对话流、不留任何持久痕迹（D5/D6 已拍板：不进 /tasks 名册、流区零痕迹、关 CLI 即没）。
 * 同时只有一个在跑（TUI 三家共识形态）：新问先中止旧在飞（qwen cancelBtw 同款）；被中止旧问
 * 切 error 态「已被新侧问取代」、不入 lastBtw 归档（只有 answer 态归档）；abort 与完成同拍时
 * 以先到者为准、已入终态的槽不覆写。
 */
import { deriveMessages } from "@orosus/core";
import type { Harness, SessionEvent } from "@orosus/core";
import type { Chunk, ModelMessage } from "@orosus/contracts/provider";
import * as theme from "./theme.ts";
import { renderMarkdown } from "./mdpipe.ts";
import { SPIN_FRAMES } from "./tui/fullapp.ts";
import type { FullApp } from "./tui/fullapp.ts";
import { truncateToWidth } from "./tui/width.ts";

/** 侧问角色话术（§四：四要素 = 五家收敛定式——独立轻量实例 / 主对话未被打断 / 无工具单轮 /
 *  不知道就说不、不许承诺去查）。英文与描述层全英方向一致（m5-tool-lang 口径）。 */
export const BTW_ROLE_PROMPT = `You are a side-question assistant. The user asked a quick question on the side
while the main agent keeps working — the main conversation is NOT interrupted,
and you are not part of it.
- The conversation history above is inherited purely as context; answer the
  question from it.
- You have NO tools, and there is no follow-up turn — answer directly in this
  single response.
- If the answer is not in the conversation, say so plainly instead of guessing.
  Never promise to look something up or take any action.
- Reply in the same language as the question.`;

/** 无参 /btw 无记录（或尚无归档）时的用法提示——toast 一行，不进流区不落盘（D6 同口径）。 */
export const BTW_USAGE_HINT = "用法：/btw <问题>——带着当前对话上下文的旁路快问，不打断主对话；无参可回看最近一次问答";

/** buildBtwRequest 的结构面（真身 = Harness；测试桩件只需 history + graph().promptSections）。 */
export interface BtwRequestSource {
  history(): Promise<SessionEvent[]>;
  graph(): { promptSections(): string };
}

/** 直调请求形状（h.llm().stream 的子集——侧问只填这三样，effort 不传走 provider 默认＝自动标题同款）。 */
export interface BtwStreamReq {
  system?: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
}

export type BtwDeps = {
  getH: () => Harness;
  /** 直调缝（缺省 = getH().llm().stream——T1 暴露口；测试注入 fake 观察请求与产出）。 */
  llmStream?: (req: BtwStreamReq) => AsyncIterable<Chunk>;
  /** 行模式输出通道（full 模式不传——答案进 dock 窗，流区零痕迹 D6）；行模式答案/错误经此回显。 */
  out?: (s: string) => void;
};

/** 侧问三态槽（live 闭包每帧读——T3 窗接线消费；测试观察口同源）。 */
export interface BtwSlot {
  question: string;
  phase: "answering" | "answer" | "error";
  /** answer 态 = 答案全文；error 态 = 失败原因；answering 态 = 流式累积正文（升级档：chunk 边收边写，
   *  live 每秒一跳呈现——窗口 1 秒龄门 tick 是现成机制，渲染侧零新增）。 */
  text: string;
  /** 思考预览（kimi thinking 预览同款）：reasoning/delta 累积——answering 态灰字末两行显示，
   *  正文到来后顶在上方、answer 态整块退役；不进最终答案文（零落盘口径不变）。 */
  thinking?: string;
  readonly startedAt: number;
};

/** openBtw 返回句柄：slot 供窗/测试观察，done 在终态落定后 resolve（fire-and-forget 的可等待面）。 */
export interface BtwHandle {
  slot: BtwSlot;
  done: Promise<void>;
}

/** 投影尾部防御（§三 步骤 3）：快照可能切在「tool/call 已落、result 未落」的工具执行窗口——投影
 *  尾部挂一条缺果 toolCalls（主循环自己从不会遇到的形态，btw 是第一个消费者，严格端会拒）。
 *  末条 assistant 带缺果 toolCalls → 剥掉 toolCalls 保留正文（cc stripInProgressAssistantMessage
 *  同族问题）；剥后空 content（纯工具回合）整条去——与 deriveMessages 尾滤同判。 */
export function stripTrailingDanglingToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "assistant" || last.toolCalls === undefined || last.toolCalls.length === 0) return messages;
  const { toolCalls: _strip, ...rest } = last;
  if (rest.content.length === 0) return messages.slice(0, -1);
  return [...messages.slice(0, -1), rest];
}

/** 侧问请求拼装（纯函数）：system = promptSections 现算 + 话术尾段（D4：一次拼进 system，不做
 *  cc 式每问包装——不追缓存纯付 token）；messages = 历史同源投影（deriveMessages，与主循环
 *  同款）+ 尾追问题消息。上下文 = 调用瞬间的一次只读快照（正在流式的回答不可见——assistant/message
 *  完成才落事件）。 */
export async function buildBtwRequest(h: BtwRequestSource, question: string): Promise<{ system: string; messages: ModelMessage[] }> {
  const system = `${h.graph().promptSections()}\n\n${BTW_ROLE_PROMPT}`;
  const messages = [
    ...stripTrailingDanglingToolCalls(deriveMessages(await h.history())),
    { role: "user", content: [{ kind: "text", text: question }] } as ModelMessage,
  ];
  return { system, messages };
}

/** 窗标题：问题首行前 16 字（不足整题；超长截断加 …——16 字 ≈ dock 标题行预算，§三 步骤 3；
 *  取首行防多行问题把框顶打穿）。 */
export function btwTitle(question: string): string {
  const head = (question.split("\n")[0] ?? "").trim();
  return `侧问 · ${head.length > 16 ? `${head.slice(0, 16)}…` : head}`;
}

// —— 进程级单件状态（单飞自律；纯临时物——关 CLI 即没，cc/qwen 同款）：
/** 在飞侧问的中止器（同时最多一个在跑——新问先 abort 旧在飞）。 */
let btwAbort: AbortController | undefined;
/** 最近一次已完成问答（仅 answer 态归档；被中止/失败的问不入——D7 内存槽回看）。 */
let lastBtw: { question: string; text: string } | undefined;

/** 无参 /btw 回看数据口（D7）：lastBtw 内存槽——仅本进程存活；undefined = 无记录（调用方 toast
 *  BTW_USAGE_HINT）。在飞未归档不算（边缘披露：关窗后侧问仍在跑、尚无归档时敲无参 = 同样落提示，
 *  跑完自归档进槽）。 */
export function lastBtwArchive(): { question: string; text: string } | undefined {
  return lastBtw;
}

/** 无参 /btw 回看（D7）：lastBtw 归档重开 dock 窗（静态答案，无 live 不重跑）；false = 无记录——
 *  调用方 toast BTW_USAGE_HINT。行模式经 deps.out 回显（方案未涉行模式的角落，按 /tasks 行模式
 *  out(body) 同构处置——偏差台账记）。 */
export function reopenBtw(app: FullApp | undefined, deps: BtwDeps): boolean {
  const archive = lastBtwArchive();
  if (archive === undefined) return false;
  const slot: BtwSlot = { question: archive.question, phase: "answer", text: archive.text, startedAt: 0 };
  if (app !== undefined) {
    app.viewText(btwTitle(archive.question), renderBtwView(slot, app.pickRowWidth()), { layout: "dock" });
  } else {
    deps.out?.(`[侧问] ${archive.question}\n${archive.text}`);
  }
  return true;
}

/** 侧问窗三态视图（纯函数——live 闭包每帧现调，1 秒龄门粒度即「1 秒一跳」呈现节拍〔升级档〕）：
 *  answering = 思考预览（末两行灰字，正文到来顶在下方）+ 流式累积正文（renderMarkdown 同源公共口，
 *  mdpipe.ts:18 流区同管线——零新渲染代码）+ 转盘尾行（纯思考期标「思考中」）；answer = 完整 md；
 *  error = 红字一行（§三·五：不另画）。 */
export function renderBtwView(slot: BtwSlot, width: number): string {
  const w = Math.max(10, width);
  if (slot.phase === "answering") {
    const secs = Math.max(0, Math.floor((Date.now() - slot.startedAt) / 1000));
    const frame = SPIN_FRAMES[Math.floor(Date.now() / 1000) % SPIN_FRAMES.length]!;
    const onlyThinking = slot.text === "" && (slot.thinking ?? "") !== "";
    const parts: string[] = [];
    const thinkLines = (slot.thinking ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
    for (const l of thinkLines.slice(-2)) parts.push(theme.dim(truncateToWidth(l, w))); // 思考预览：末两行防顶飞正文
    if (slot.text !== "") parts.push(renderMarkdown(slot.text, w).join("\n")); // 流式正文
    parts.push(theme.fg("accent", frame) + " " + theme.fg("muted", `${onlyThinking ? "思考中" : "回答中"} · ${secs}s`));
    return parts.join("\n");
  }
  if (slot.phase === "error") return theme.fg("err", slot.text.split("\n")[0] ?? slot.text);
  return renderMarkdown(slot.text, Math.max(10, width)).join("\n");
}

/** 带参侧问（fire-and-forget：命令分支立即返回，路由不被 LLM 挂住；不占 inflight/busy——T4 经
 *  BUSY_EXEC 命中走此口）。full 模式立即开 dock 窗（pendingUi 单槽，第二问排队 FIFO——§七 已知
 * 局限）；行模式答案/错误经 deps.out 回显。 */
export function openBtw(app: FullApp | undefined, deps: BtwDeps, question: string): BtwHandle {
  // 新问先中止旧在飞（qwen cancelBtw 同款）——旧槽由其闭包自行切 error「已被新侧问取代」
  btwAbort?.abort();
  const ac = new AbortController();
  btwAbort = ac;
  const slot: BtwSlot = { question, phase: "answering", text: "", startedAt: Date.now() };
  let doneResolve: (() => void) | undefined;
  const done = new Promise<void>((r) => { doneResolve = r; });
  const call = deps.llmStream ?? ((req: BtwStreamReq) => deps.getH().llm().stream(req));
  if (app !== undefined) {
    // 立即开窗占槽（首帧即转盘行，不等 1s tick）；折宽 = dock 内容宽惯例（hooks-ui/mcp-ui 同款 pickRowWidth）
    app.viewText(btwTitle(question), renderBtwView(slot, app.pickRowWidth()), {
      layout: "dock",
      live: () => renderBtwView(slot, app.pickRowWidth()), // 三态每帧现算——拖宽即时回流
    });
  } else {
    // 行模式：跑完经 out 回显（full 模式流区零痕迹 D6 在此成立——out 只在行模式布线时传）
    void done.then(() => {
      if (deps.out === undefined) return;
      if (slot.phase === "answer") deps.out(`[侧问] ${slot.text}`);
      else if (slot.phase === "error") deps.out(`[侧问失败] ${slot.text}`);
    });
  }
  void (async () => {
    /** 终态落定（一次性）：已入终态不覆写——abort 与完成同拍时以先到者为准（T2 测试钉）。 */
    const finish = (phase: "answer" | "error", text: string): void => {
      if (slot.phase !== "answering") return;
      slot.phase = phase;
      slot.text = text;
      if (phase === "answer") lastBtw = { question: slot.question, text }; // 只有 answer 态归档
    };
    const replaced = (): boolean => {
      if (!ac.signal.aborted) return false;
      finish("error", "已被新侧问取代");
      return true;
    };
    try {
      const { system, messages } = await buildBtwRequest(deps.getH(), question);
      if (replaced()) return;
      let text = "";
      let thinking = "";
      for await (const c of call({ system, messages, signal: ac.signal })) {
        if (c.type === "text/delta") {
          text += c.text;
          slot.text = text; // 流式：边收边写——live 每秒读槽即「1 秒一跳」呈现
        } else if (c.type === "reasoning/delta") {
          thinking += c.text;
          slot.thinking = thinking; // 思考预览（不进最终答案文——text 只收 text/delta）
        } else if (c.type === "finish") {
          // 带内错误形态（llm 口失败不抛、yield finish/error——只 try/catch 会漏成空答案进 answer 态）
          if (c.kind === "error") { finish("error", c.errorMessage ?? "llm 调用失败"); return; }
          // 适配器静默中止（无本侧 signal）也诚实记失败，不把半截当答案
          if (c.kind === "aborted" && !ac.signal.aborted) { finish("error", "已中止"); return; }
          break; // stop/length = 完整答案（无工具单轮，toolUse 不会出现）；finish 后流即尽
        }
        // usage、server-search：侧问不消费
      }
      if (replaced()) return; // 适配器被 abort 后静默收流（不抛不 yield aborted）的形态
      finish("answer", text);
    } catch (err) {
      if (replaced()) return; // abort 途中抛（AbortError 等）→ 被新问取代，不当失败文案
      finish("error", err instanceof Error ? err.message : String(err));
    } finally {
      doneResolve?.();
    }
  })();
  return { slot, done };
}
