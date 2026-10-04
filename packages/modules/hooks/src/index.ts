import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import type { CapabilityKey } from "@orosus/contracts/module";
import { HOOK_EVENTS, configSchema, defaultProjectConfigFile, defaultUserConfigFile, loadHooksConfig, type HookEvent } from "./config.ts";
import { mergeInjections, runHook, type InjectionState } from "./executor.ts";
import { dispatchEvent, type DispatchCtx } from "./dispatch.ts";

export { HOOK_EVENTS, configSchema, defaultProjectConfigFile, defaultUserConfigFile, loadHooksConfig } from "./config.ts";
export { dispatchEvent, basePayload } from "./dispatch.ts";
export { runHook, parseHookJson, applyInjectionGates, stripAnsiAndControl, mergeInjections, buildHookEnv, expandCommand, resolveShell, INJECT_SINGLE_CAP, INJECT_SESSION_CAP } from "./executor.ts";
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
    // 自读门：通用 section 出现过任一事件表才自读两份 TOML（hermetic 密封下真实 home 的配置零旁路——见 config.ts 注释）
    const compiled = loadHooksConfig({
      sectionHasTables: HOOK_EVENTS.some((e) => Array.isArray((cfg as Record<string, unknown>)[e])),
      userFile: cfg.userConfigFile ?? defaultUserConfigFile(),
      projectFile: cfg.projectConfigFile ?? defaultProjectConfigFile(process.cwd()),
      enabled: cfg.enabled,
      timeoutMs: cfg.timeoutMs,
      warn: (msg) => { ctx.log.warn("hooks.config", msg, {}); },
    });
    if (!compiled.enabled) return; // 总闸关——零监听（空配置零行为同此路径）
    const has = (e: HookEvent): boolean => (compiled.tables[e]?.length ?? 0) > 0;
    if (!HOOK_EVENTS.some(has)) return; // 无任何事件表——零监听

    // 运行期闭包（会话生命周期、reload 重置、刻意不持久化——设计总览「记录与存储账本」）
    const injectionState: InjectionState = { injectedChars: 0 };
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
      const r = await dispatchEvent("PreToolUse", p.name, specific, dctx);
      if (r.veto !== undefined) return { deny: true, reason: `钩子拦截：${r.veto.reason}` };
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
      return dispatchEvent(event, p.name, specific, dctx).then((r) => { enqueue(event, r.injections); });
    });

    // UserPromptSubmit / Stop：T7 接线；PermissionRequest：T8 经 provide 由 approval 惰性消费
    ctx.provide("hooks.permission-verdict", async () => undefined); // T8 充实（未表态 = undefined 照旧弹窗）
  },
});
