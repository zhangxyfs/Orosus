/** btw 服务端多轮实例（web 批 W5，问题 2——CLI 形态不动，见 btw-cmd.ts 的无工具单轮路径）：
 *  轻量多轮直调（known-issues.md:87 备选定案）——**不走 runner**：保住 D5 不进花名册、D6 零落盘两条
 *  原拍板；代价 = 自管轮次保险丝 + 单飞 abort（粒度 per-tab）。
 *  - 实例：`{tab, rounds, ctrl}` 存每会话 `Map<tab, instance>`（WeakMap<HostedSession, …> 沿用
 *    cmdrouter.ts 既有形态）；同 tab 新问先 abort 旧在飞（runBtw 会话级单飞的 tab 级化），已完成轮
 *    rounds 随实例存活跨问复用；会话关停统一 abort 全部在飞（「关 CLI 即没」的 web 同构）。
 *  - 请求拼装：每问每请求都经 buildBtwRequest（tools:"readonly" + rounds）重拼——最新主历史每轮
 *    重取（只感知主对话，看不到子代理）；工具往返（assistant toolCalls + toolResult 对）只在本问内
 *    累积（carry），不跨问。
 *  - 工具面：主图三只读工具（tool-fs__read/grep/glob）经 `hs.core.graph().tools.list()` 过滤三名取得
 *    ——specs 进请求 tools 通道（LlmPort.stream 可选参，W5 契约增量），白名单外工具模型不可见；
 *    执行为直调（resolveExecution → execute）并盖 `agent:{agentId:"btw/"+tab, depth:1}` 身份章——
 *    tool-fs 守卫记忆按身份分桶（批次一 T5）自动进 btw 专属桶，主对话/子代理互不稀释。三只读工具
 *    无写访问，不接审批闸（简报明文）；registry 的审批瀑布/溢写落盘两条均不适用（后者与 D6 零落盘
 *    相抵，超限输出就地截断不溢写）。
 *  - 保险丝：单问内查证轮（模型回工具调用的请求轮）至多 8——到顶熔断回 error 帧，不执行不再请求。
 *  - 帧：HostedSession.emitBtw `{tab, phase, text, round}`——answering 累积式 / tool「查证中…」/
 *    answer 终态 / error；round = 问题轮序（1 起）。零落盘（D6）：不经 store/loop，主会话 history 与
 *    子代理目录均无 btw 痕迹。 */
import { z } from "zod";
import type { Harness } from "@orosus/core";
import type { ModelMessage, ToolSpec } from "@orosus/contracts/provider";
import type { Logger } from "@orosus/contracts/module";
import type { Tool, ToolExecution, ToolResult } from "@orosus/contracts/tool";
import { buildBtwRequest, type BtwRound } from "../btw-cmd.ts";
import { archiveBtwRounds } from "./cmdrouter.ts";
import { readBtwModel } from "./gui-settings.ts";
import type { BtwFrame, HostedSession } from "./hosted.ts";

/** btw 只读工具白名单（主图实名——模型面 name 即调用名；写/改/派活类一律不出面）。 */
export const BTW_TOOL_WHITELIST: readonly string[] = ["tool-fs__read", "tool-fs__grep", "tool-fs__glob"];

/** 单问查证轮上限（保险丝——自管轮次；到顶熔断回 error 帧不执行不再请求）。 */
export const BTW_MAX_TOOL_ROUNDS = 8;

/** btw 工具输出上限（字节按 length 近似，registry OUTPUT_LIMIT 同量级）：超限就地截断头尾双保留
 *  ——不溢写文件（D6 零落盘口径：btw 痕迹不进会话目录任何角落）。 */
const BTW_OUTPUT_LIMIT = 32768;
const BTW_OUTPUT_HEAD = 24576;
const BTW_OUTPUT_TAIL = 8192;

const capBtwOutput = (output: string): string => {
  if (output.length <= BTW_OUTPUT_LIMIT) return output;
  const cut = output.length - BTW_OUTPUT_HEAD - BTW_OUTPUT_TAIL;
  return `${output.slice(0, BTW_OUTPUT_HEAD)}\n[…btw 查证输出超限，中段截断 ${cut} 字符（零落盘口径——不溢写文件）…]\n${output.slice(-BTW_OUTPUT_TAIL)}`;
};

/** 工具执行期 logger（ToolContext.log 三件套之一）：静默实现——btw 是旁路快问，诊断面不为其
 *  单开通道（错误带内进 ToolResult，失败对模型可见自纠）。 */
const silentLog: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 主图三只读工具面：specs（进请求 tools 通道）+ 对象表（执行直调用）——每次请求现取（reload 后
 *  按新图解析，不缓存旧工具对象）。 */
const btwToolsOf = (h: Harness): { specs: ToolSpec[]; byName: Map<string, Tool> } => {
  const want = new Set(BTW_TOOL_WHITELIST);
  const byName = new Map<string, Tool>();
  const specs: ToolSpec[] = [];
  for (const t of h.graph().tools.list()) {
    if (!want.has(t.name)) continue;
    byName.set(t.name, t);
    specs.push({ name: t.name, description: t.description, parameters: z.toJSONSchema(t.parameters) as Record<string, unknown> });
  }
  return { specs, byName };
};

/** 三只读工具直调（身份盖章执行）：schema 校验 → resolveExecution → execute（ctx.agent = btw/<tab>——
 *  tool-fs 守卫/去重桶按此键隔离，T5 机制面）。错误带内（ToolResult isError），不抛。 */
const execBtwTool = async (
  h: Harness,
  tab: string,
  call: { id: string; name: string; args: unknown },
  signal: AbortSignal,
): Promise<ToolResult> => {
  const tool = btwToolsOf(h).byName.get(call.name);
  if (tool === undefined) return { output: `未知工具 "${call.name}"（btw 只读工具面不含它）`, isError: true };
  const parsed = tool.parameters.safeParse(call.args);
  if (!parsed.success) {
    return { output: `参数校验失败：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, isError: true };
  }
  let execution: ToolExecution;
  try {
    execution = await tool.resolveExecution(parsed.data);
  } catch (err) {
    return { output: `resolveExecution 抛错：${String(err)}`, isError: true };
  }
  try {
    const result = await execution.execute({
      callId: call.id,
      signal,
      log: silentLog,
      agent: { agentId: `btw/${tab}`, depth: 1 }, // 执行身份（T1/T5）：守卫记忆进 btw 专属桶
    });
    return { ...result, output: capBtwOutput(result.output) };
  } catch (err) {
    return { output: `工具执行抛错：${String(err)}`, isError: true };
  }
};

/** btw 选项卡实例：rounds = 已完成问答轮串（跨问存活），ctrl = 本 tab 单飞中止器；
 *  stopRequested = 用户手动停止（走查修④）——与被新问取代共用 abort 通道但结算口径不同：
 *  取代 = 静默退场（新问接管帧面）；手动停止 = 落定当前轮（已积累文本 + 〔已停止〕尾注 + 归档）。 */
interface BtwInstance {
  tab: string;
  rounds: BtwRound[];
  ctrl: AbortController;
  stopRequested?: boolean;
}

/** 每会话的 btw 实例表（tab id → instance；cmdrouter.btwBySession 同款 WeakMap 形态）。 */
const btwTabs = new WeakMap<HostedSession, Map<string, BtwInstance>>();

/** 带参侧问受理口（W5 多轮形态——POST /api/sessions/:sid/btw 消费；fire-and-forget：受理即返，
 *  答案经 SSE btw 帧回流）。同 tab 新问先中止旧在飞（被中止问静默退场、不入归档）；rounds 随实例
 *  跨问存活。每问内：请求 → 文本流（answering 累积帧）→ 遇工具调用执行回注续流（tool 帧）→ 无调用
 *  即 answer（push rounds + 归档 + answer 帧）；保险丝 8 轮熔断 error 帧。 */
export function askBtw(hs: HostedSession, tab: string, q: string, opts?: { model?: string; effort?: string }): void {
  const h = hs.core;
  if (h === undefined) throw new Error("会话装配失败");
  let tabs = btwTabs.get(hs);
  if (tabs === undefined) {
    tabs = new Map();
    btwTabs.set(hs, tabs);
    // 会话关停 → 全部在飞侧问中止（runBtw onClose 单中止器的 tab 集合化）
    hs.onClose(() => {
      for (const inst of btwTabs.get(hs)?.values() ?? []) inst.ctrl.abort();
    });
  }
  const prior = tabs.get(tab);
  prior?.ctrl.abort(); // 单飞 per-tab：新问先中止旧在飞（qwen cancelBtw 同款）
  const inst: BtwInstance = { tab, rounds: [...(prior?.rounds ?? [])], ctrl: new AbortController() };
  tabs.set(tab, inst);
  const roundNo = inst.rounds.length + 1; // 本问轮序（帧 round——同问内查证与回答同号）
  /* 默认模型 = 设置「模型偏好 → 侧问模型」——无 tab 覆盖时读 gui/gui.toml [sideQuestion].model
   *  （每问现读文件——改偏好零重载即时生效；侧问是手动低频动作，读盘开销可忽略）。 */
  const effModel = opts?.model ?? readBtwModel();
  const emit = (phase: BtwFrame["phase"], text: string): void => {
    hs.emitBtw({ tab, phase, text, round: roundNo });
  };
  let latestText = ""; // 本问已积累正文（手动停止落定的读取面——IIFE 流内更新）
  let think = ""; // 累积思考文本（走查修②：reasoning/delta 消费——与主流思考块同源，answer 后保留）
  /* 手动停止落定（走查修④）：仅 stopRequested 时结算——把在飞轮落成「已积累文本 + 〔已停止〕尾注」
   *  并入轮串归档（与正常 answer 同面：前端收到 answer 帧即定终态，不再悬「回答中…」）。 */
  const settleIfStopped = (): void => {
    if (!inst.stopRequested) return;
    const partial = latestText; // 中止瞬间已积累的文本（无则空——尾注自成内容）
    const settled = partial === "" ? "〔已停止〕" : `${partial}

〔已停止〕`;
    inst.rounds.push({ q, a: settled });
    archiveBtwRounds(hs, inst.rounds);
    emit("answer", settled);
  };
  void (async () => {
    const carry: ModelMessage[] = []; // 本问内工具往返（assistant toolCalls + toolResult 对——不跨问）
    try {
      for (let reqRound = 1; ; reqRound++) {
        if (inst.ctrl.signal.aborted) { settleIfStopped(); return; }
        // 每请求重拼：最新主历史（每轮重取）+ 前序 rounds 平铺 + 本问尾追 + 本问工具往返
        const { system, messages } = await buildBtwRequest(h, q, { tools: "readonly", rounds: inst.rounds });
        const face = btwToolsOf(h);
        let text = "";
        const pending = new Map<string, { callId: string; name: string; argsJson: string }>();
        for await (const c of h.llm().stream({
          system, messages: [...messages, ...carry], tools: face.specs, signal: inst.ctrl.signal,
          ...(effModel !== undefined ? { model: effModel } : {}), // 模型解析序：tab 覆盖 > 设置「侧问模型」偏好 > 缺省（会话当前）
          ...(opts?.effort !== undefined ? { reasoningEffort: opts.effort } : {}), // tab 级思考档覆盖（契约增量透传）
        })) {
          if (c.type === "text/delta") {
            text += c.text;
            latestText = text;
            emit("answering", text); // 累积式（前端晚开窗整段渲染）
          } else if (c.type === "reasoning/delta") {
            think += c.text;
            emit("thinking", think); // 走查修②：思考流帧（前端活跃 tab 增量渲染——与主流思考块同源）
          } else if (c.type === "toolcall/argumentsDelta") {
            const p = pending.get(c.callId) ?? { callId: c.callId, name: "", argsJson: "" };
            if (c.name !== undefined && c.name !== "") p.name = c.name;
            p.argsJson += c.argumentsDelta;
            pending.set(c.callId, p);
          } else if (c.type === "finish") {
            if (c.kind === "error") throw new Error(c.errorMessage ?? "llm 调用失败"); // 带内错误此刻升级（openBtw 同口径）
            break; // stop/length/toolUse/aborted——有无 pending 决定续流（aborted 由下方统一哨兵接）
          }
          // reasoning/usage/server-search：侧问小窗不消费
        }
        if (inst.ctrl.signal.aborted) { settleIfStopped(); return; } // 取代静默 / 手动停止落定（走查修④）
        const calls = [...pending.values()];
        if (calls.length === 0) {
          inst.rounds.push({ q, a: text });
          archiveBtwRounds(hs, inst.rounds); // 无参 /btw 回看槽（cmdrouter 内存归档）
          emit("answer", text);
          return;
        }
        // 保险丝：查证轮到顶即熔断（不执行、不发下一次请求——自管轮次的代价面）
        if (reqRound >= BTW_MAX_TOOL_ROUNDS) {
          emit("error", `侧问查证超过 ${BTW_MAX_TOOL_ROUNDS} 轮上限——已停止（可缩小提问范围重试）`);
          return;
        }
        emit("tool", "查证中…"); // 前端显「查证中…」（W6 消费——本批只定帧形）
        const parsedCalls = calls.map((call) => {
          let args: unknown = {};
          try {
            args = JSON.parse(call.argsJson || "{}");
          } catch {
            args = { _rawArguments: call.argsJson };
          }
          return { call, args };
        });
        // assistant 回合先入（带 toolCalls——纯工具回合 content 留空数组，Anthropic 拒收空 text block）
        carry.push({
          role: "assistant",
          content: text === "" ? [] : [{ kind: "text", text }],
          toolCalls: parsedCalls.map(({ call, args }) => ({ callId: call.callId, name: call.name, args })),
        });
        for (const { call, args } of parsedCalls) {
          const result = await execBtwTool(h, tab, { id: call.callId, name: call.name, args }, inst.ctrl.signal);
          carry.push({ role: "toolResult", callId: call.callId, output: result.output, isError: result.isError });
        }
      }
    } catch (err) {
      if (inst.ctrl.signal.aborted) { settleIfStopped(); return; } // abort 途中抛（AbortError 等）→ 取代静默 / 手动停止落定
      emit("error", err instanceof Error ? err.message : String(err));
    }
  })();
}

/** 手动停止（走查修④——POST /btw {tab, abort:true} 消费）：标 stopRequested 再 abort——
 *  与「新问取代」共用中止通道但结算不同：askBtw 各中止哨兵认 stopRequested → 落定当前轮
 *  （已积累文本 + 〔已停止〕尾注 + answer 帧 + 归档），未标则维持取代语义静默退场。 */
export function abortBtw(hs: HostedSession, tab: string): void {
  const inst = btwTabs.get(hs)?.get(tab);
  if (inst === undefined) return;
  inst.stopRequested = true;
  inst.ctrl.abort();
}
