import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import type { CapabilityKey } from "@orosus/contracts/module";
import { HOOK_EVENTS, configSchema, defaultProjectConfigFile, defaultUserConfigFile, loadHooksConfig, type HookEvent } from "./config.ts";
import { mergeInjections, runHook, capReason, type InjectionState } from "./executor.ts";
import { dispatchEvent, type DispatchCtx } from "./dispatch.ts";
import { evaluateProjectTrust, trustFilePath } from "./trust.ts";

export { HOOK_EVENTS, configSchema, defaultProjectConfigFile, defaultUserConfigFile, loadHooksConfig } from "./config.ts";
export { dispatchEvent, basePayload } from "./dispatch.ts";
export { runHook, parseHookJson, applyInjectionGates, stripAnsiAndControl, mergeInjections, buildHookEnv, expandCommand, resolveShell, capReason, INJECT_SINGLE_CAP, INJECT_SESSION_CAP } from "./executor.ts";
export { evaluateProjectTrust, projectBucketKey, projectHooksDigest, readTrustTable, trustFilePath, canonicalJson, type TrustRecord } from "./trust.ts";
export type { HookEvent, HooksConfig, CompiledTable, CompiledHook } from "./config.ts";
export type { HookDecision, HookOutcome, InjectionState } from "./executor.ts";
export type { DispatchCtx, DispatchResult } from "./dispatch.ts";

/** PreToolUse waterfall 载荷（registry 产出 + 子代理转发补 mode/subagent）。 */
interface PreInputPayload {
  callId: string;
  name: string;
  args?: unknown;
  accesses?: unknown[];
  approvalRule?: string;
  mode?: string;
  subagent?: { agentId: string; depth: number; parentId?: string; background?: boolean; label: string };
}
/** tool/post-execute emit 载荷（loop 产出 + runner 转发补 subagent）。 */
interface PostExecutePayload {
  callId: string;
  name: string;
  result: { output: string; isError?: boolean; denied?: boolean; truncated?: boolean };
  subagent?: { agentId: string; label: string };
}

/**
 * Hooks 生命周期钩子模块（m5-hooks）。
 * 七事件 shell 命令：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure /
 * Stop / PermissionRequest。协议与 Claude Code 生态兼容（stdin snake_case JSON / 退出码 / stdout JSON）。
 * fail-open 铁律：钩子任何失败不阻断主流程（安全兜底是审批系统）。prompt 永不改写：注入一律走
 * steering 旁路（sourceModule host/hook）带 [非用户输入] 头。改参落 hooks/input-rewrite 修订账
 *（append-only，不改 tool/call 历史）——审批与写闸只见最终参数（T1 入参门保证）。
 */
export default defineModule({
  name: "hooks",
  version: "0.1.0",
  description: "Hooks 生命周期钩子——七事件 shell 命令（用户/项目两层配置、sha256 信任门、注入三道闸、Ctrl+H 注入可见），出厂 required=true",
  api: 1,
  mounts: ["hook:tool/pre-input", "hook:tool/post-execute", "hook:agent/follow-up", "hook:user/prompt-submit", "hook:session/start", "hook:agent/steering", "provide"],
  provides: ["hooks.permission-verdict"], // T8：PermissionRequest 代答（惰性——approval 弹窗前消费）
  config: configSchema,
  logEvents: ["hooks/run", "hooks/input-rewrite"],
  activate(ctx) {
    const cfg = ctx.config as z.infer<typeof configSchema>;
    const userFile = cfg.userConfigFile ?? defaultUserConfigFile();
    const projectFile = cfg.projectConfigFile ?? defaultProjectConfigFile(process.cwd()); // approval projectConfigFile 同款口径
    // 自读门：通用 section 出现过任一事件表才自读两份 TOML（hermetic 密封下真实 home 的配置零旁路——见 config.ts 注释）
    const compiled = loadHooksConfig({
      sectionHasTables: HOOK_EVENTS.some((e) => Array.isArray((cfg as Record<string, unknown>)[e])),
      userFile,
      projectFile,
      enabled: cfg.enabled,
      timeoutMs: cfg.timeoutMs,
      warn: (msg) => { ctx.log.warn("hooks.config", msg, {}); },
    });
    if (!compiled.enabled) return; // 总闸关——零监听（空配置零行为同此路径）
    const has = (e: HookEvent): boolean => (compiled.tables[e]?.length ?? 0) > 0;
    if (!HOOK_EVENTS.some(has)) return; // 无任何事件表——零监听

    // 运行期闭包（会话生命周期、reload 重置、刻意不持久化——设计总览「记录与存储账本」）
    const state = { stopContinuations: 0 }; // Stop 连拦计数（新消息清零）
    let runSeq = 0; // hooks/run runId 序（running→完成配对，T11 状态行）
    const injectionState: InjectionState = { injectedChars: 0 };
    const trustFile = cfg.trustFile ?? trustFilePath();
    const info = { sessionId: undefined as string | undefined, transcriptPath: undefined as string | undefined, cwd: process.cwd() };
    const injectionQueue: string[] = []; // steering 旁路队列（下个 step 首排空——prompt 永不改写）
    const dctx: DispatchCtx = {
      run: runHook,
      append: async (type, fields) => { await ctx.session.append(type, fields); },
      log: ctx.log,
      config: compiled,
      sessionInfo: () => ({ ...info }),
      permissionMode: async () => {
        const mode = await ctx.services.getOptional("approval.current-mode" as CapabilityKey<string>);
        return mode === undefined ? undefined : String(mode);
      },
      injectionState,
      // 信任门（T9）：dispatch 前现算不缓存——项目层改配置立即重新待审；无项目层恒放行
      projectTrusted: () => evaluateProjectTrust(projectFile, info.cwd, trustFile).trusted,
      nextRunId: () => ++runSeq,
    };
    /** 钩子命令短名（阻断明示可辨识——T11）：首词 basename（"python3 ${DIR}/guard.py …" → "python3"）；
     *  首词是解释器时带第二词（"python3 guard.py"）。 */
    const hookShort = (command: string): string => {
      const words = command.trim().split(/\s+/);
      const base = (w: string): string => w.split(/[\/]/).pop() ?? w;
      const first = base(words[0] ?? "");
      if (/^(python3?|node|bash|sh|cmd|pwsh|npx)$/i.test(first) && words[1] !== undefined) return `${first} ${base(words[1])}`;
      return first;
    };
    const enqueue = (event: HookEvent, texts: string[]): void => {
      if (texts.length === 0) return;
      injectionQueue.push(texts.length === 1 ? texts[0]! : mergeInjections(texts));
    };

    // steering 注入通道（collect 链一环）：队列经 agent/steering-message 落日志进上下文——sourceModule
    // host/hook 获得召回跳过/压缩保留/折叠行渲染三语义（D19 注入可见的唯一数据源，无第二份）
    ctx.events.on("agent/steering", () => injectionQueue.splice(0).map((text) => ({ text, sourceModule: "host/hook" })));

    // 会话起点：缓存 session_id/transcript_path/cwd（后续事件载荷用——T0-② 取证：ctx.session 无路径口）
    ctx.events.on("session/start", async (payload) => {
      const p = payload as { source?: string; session_id?: string; transcript_path?: string; cwd?: string };
      if (p.session_id !== undefined) info.sessionId = p.session_id;
      if (p.transcript_path !== undefined) info.transcriptPath = p.transcript_path;
      if (p.cwd !== undefined) info.cwd = p.cwd;
      if (p.source !== undefined && has("SessionStart")) {
        void dispatchEvent("SessionStart", p.source, { source: p.source }, dctx)
          .then((r) => { enqueue("SessionStart", r.injections); })
          .catch(() => undefined); // fail-open：派发面异常不阻断会话启动
      }
    });

    // PreToolUse：拦截（deny）与改参（updatedInput→重校验重解在 T1 入参门）——审批之前的位置
    ctx.events.on("tool/pre-input", async (payload) => {
      const p = payload as PreInputPayload;
      const specific: Record<string, unknown> = {
        tool_name: p.name,
        tool_input: p.args ?? {},
        tool_use_id: p.callId,
        ...(p.subagent !== undefined ? { agent_id: p.subagent.agentId, agent_type: p.subagent.label } : {}), // D18：载荷带身份
      };
      const r = await dispatchEvent("PreToolUse", p.name, specific, dctx, p.subagent?.agentId);
      if (r.veto !== undefined) {
        const by = r.veto.hook !== undefined ? `（${hookShort(r.veto.hook)}）` : "";
        return { deny: true, reason: `钩子拦截${by}：${r.veto.reason}` };
      }
      if (r.updatedInput !== undefined && p.args !== r.updatedInput) {
        await ctx.session.append("hooks/input-rewrite", { callId: p.callId, from: p.args, to: r.updatedInput }); // 修订账（append-only）
        (p as { args?: unknown }).args = r.updatedInput; // 引用判变 → T1 入参门重校验+重解+重走审批
      }
      return undefined;
    });

    // PostToolUse / PostToolUseFailure：isError 分流（同一挂点，两张表）
    ctx.events.on("tool/post-execute", (payload) => {
      const p = payload as PostExecutePayload;
      const event: HookEvent = p.result.isError === true ? "PostToolUseFailure" : "PostToolUse";
      if (!has(event)) return undefined;
      const specific: Record<string, unknown> = {
        tool_name: p.name,
        tool_response: { output: p.result.output, is_error: p.result.isError === true, ...(p.result.denied === true ? { denied: true } : {}), ...(p.result.truncated === true ? { truncated: true } : {}) },
        tool_use_id: p.callId,
        ...(p.subagent !== undefined ? { agent_id: p.subagent.agentId, agent_type: p.subagent.label } : {}),
      };
      return dispatchEvent(event, p.name, specific, dctx, p.subagent?.agentId).then((r) => { enqueue(event, r.injections); });
    });

    // UserPromptSubmit：整条拒收（deny）与 additionalContext → contextNotes（T2 通道直推 steering，
    // sourceModule host/hook 由 harness 侧统一加）。新消息清零 Stop 续跑计数（用户拍板新方向优先）——
    // 监听在「配了任一提交/停止事件」时挂（清零责任不能只随 UserPromptSubmit 表——只配 Stop 时也要清）。
    if (has("UserPromptSubmit") || has("Stop")) {
      ctx.events.on("user/prompt-submit", async (payload) => {
        state.stopContinuations = 0;
        if (!has("UserPromptSubmit")) return undefined;
        const p = payload as { text: string; images?: string[]; contextNotes: string[] };
        const specific: Record<string, unknown> = { prompt: p.text, ...(p.images !== undefined ? { images: p.images } : {}) };
        const r = await dispatchEvent("UserPromptSubmit", undefined, specific, dctx);
        if (r.veto !== undefined) {
          // T11 阻断明示（qwen 形态）：被拒的输入必须让用户看得见——钩子名 + 理由 + 原文首行摘要
          const by = r.veto.hook !== undefined ? `（${hookShort(r.veto.hook)}）` : "";
          const firstLine = p.text.split("\n")[0]!.slice(0, 40);
          return { deny: true, reason: `钩子${by}拦截：${r.veto.reason}｜被拒原文「${firstLine}${p.text.length > 40 ? "…" : ""}」` };
        }
        for (const injection of r.injections) p.contextNotes.push(injection);
        return undefined;
      });
    }

    // Stop：停止边界、turn 收口前（agent/follow-up collect 链）——阻断 = 返回续跑消息，代理带着理由继续
    //（零内核改动得到 Claude「Stop hook 阻止停止」语义）。连拦封顶 3 次防死循环（ZCode 同值）；错误/中止
    // 轮不过停止边界（loop.ts:256-293 先 break——T0-③ 取证）；shouldStop 真停时消息照落日志但不复活轮（CL-07）。
    if (has("Stop")) {
      ctx.events.on("agent/follow-up", async () => {
        const specific: Record<string, unknown> = { stop_hook_active: state.stopContinuations > 0 };
        const r = await dispatchEvent("Stop", undefined, specific, dctx);
        if (r.veto === undefined) return [];
        if (state.stopContinuations >= 3) {
          await ctx.session.append("hooks/run", { event: "Stop", status: "stop-cap", detail: `连续续跑已达 ${state.stopContinuations} 次封顶，本次放行停止（防死循环）` });
          return [];
        }
        state.stopContinuations++;
        const reason = capReason(r.veto.reason);
        // sourceModule "hooks"：续跑消息折叠行渲染依据（D19）+ 压缩保留谓词第二值
        return [{ text: `[非用户输入] 钩子要求继续：${reason}`, sourceModule: "hooks" }];
      });
    }

    // PermissionRequest 代答（T8）：approval 弹窗前惰性消费（服务倒挂）。载荷经服务参数带入
    //（方案原签名 ()——不带参会丢 tool_name，偏差改 {toolName, toolInput}）；deny/allow 折裁决、
    // 未表态 undefined 照旧弹窗；allow 的升档效力只在此处成立（PreToolUse 位无升档 D8）。
    ctx.provide("hooks.permission-verdict", async (info?: { toolName: string; toolInput?: unknown; subagent?: string }) => {
      if (!has("PermissionRequest") || info === undefined) return undefined;
      const specific: Record<string, unknown> = { tool_name: info.toolName, tool_input: info.toolInput ?? {}, ...(info.subagent !== undefined ? { agent_id: info.subagent } : {}) };
      const r = await dispatchEvent("PermissionRequest", info.toolName, specific, dctx);
      if (r.veto !== undefined) return { verdict: "deny" as const, reason: r.veto.reason };
      if (r.allowed === true) return { verdict: "allow" as const };
      return undefined;
    });
  },
});
