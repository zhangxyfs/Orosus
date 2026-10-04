import { runHook, applyInjectionGates, type HookOutcome, type InjectionState } from "./executor.ts";
import type { CompiledTable, HookEvent } from "./config.ts";

/** 派发上下文：index.ts 装配（真 harness 或测试注入）。 */
export interface DispatchCtx {
  run: typeof runHook;                                  // 执行器（测试可换桩）
  append: (type: string, fields: Record<string, unknown>) => Promise<unknown>; // ctx.session.append
  log: { warn: (code: string, msg: string, data?: Record<string, unknown>) => void };
  config: { timeoutMs: number; tables: Partial<Record<HookEvent, CompiledTable[]>> }; // 编译后的表（两层已合并）
  sessionInfo: () => { sessionId: string | undefined; transcriptPath: string | undefined; cwd: string }; // session/start 缓存口
  permissionMode: () => Promise<string | undefined>;    // approval.current-mode 惰性消费
  injectionState: InjectionState;
  projectTrusted: () => boolean;                        // 信任门现算口（T9：false = 项目层整层跳过；无项目层恒 true）
}

export interface DispatchResult {
  veto?: { deny: true; reason: string };  // waterfall deny（调用方原样返回）
  updatedInput?: unknown;                 // PreToolUse 改参（末次生效——串行链上后写的赢）
  allowed?: boolean;                      // 任一钩子明示 permissionDecision:"allow"（PreToolUse 无升档 D8；PermissionRequest 代答放行的信号）
  injections: string[];                   // 过闸后的注入正文（mergeInjections 由调用方决定时机）
}

/** 基础载荷（snake_case）：公共五字段 + 事件专有由调用方并进。缺省口（transcript 未缓存）省字段。 */
export function basePayload(event: HookEvent, info: { sessionId: string | undefined; transcriptPath: string | undefined; cwd: string }, permissionMode: string | undefined): Record<string, unknown> {
  return {
    hook_event_name: event,
    ...(info.sessionId !== undefined ? { session_id: info.sessionId } : {}),
    ...(info.transcriptPath !== undefined ? { transcript_path: info.transcriptPath } : {}),
    cwd: info.cwd,
    ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
  };
}

/** 串行执行 + deny 粘滞短路（D9：首个 deny 后不再跑后续钩子；两层序用户层在前已在编译时合并）。
 *  fail-open 铁律：error/timeout 不阻断主流程——hooks/run 落账 + warn 后继续下一个钩子。
 *  allow 在 PreToolUse 无升档效力（D8）——本层不产出任何放行承诺，升档只走 T8 PermissionRequest。 */
export async function dispatchEvent(event: HookEvent, matchValue: string | undefined, specific: Record<string, unknown>, dctx: DispatchCtx): Promise<DispatchResult> {
  const result: DispatchResult = { injections: [] };
  const tables = dctx.config.tables[event] ?? [];
  if (tables.length === 0) return result;
  let skippedUntrusted = 0;
  const info = dctx.sessionInfo();
  const permissionMode = event === "SessionStart" ? undefined : await dctx.permissionMode().catch(() => undefined);
  const base = basePayload(event, info, permissionMode);
  const subagent = (specific["subagent"] as { agentId?: string } | undefined) ?? undefined;
  for (const table of tables) {
    // 信任门（T9）：项目层未过 sha256 审查整层不执行（用户层不受影响）；dispatch 前现算（改配置立即待审）
    if (table.origin === "project" && !dctx.projectTrusted()) {
      skippedUntrusted++;
      continue;
    }
    // 无匹配值事件（UserPromptSubmit/Stop）：matcher 恒忽略（写了不报错——设计空白表「matcher 语义」行）
    if (matchValue !== undefined && !table.match(matchValue)) continue;
    for (const hook of table.hooks) {
      if (hook.disabled === true) continue; // /settings e 键停用位——跳过不执行（配置保留，审计零账）
      const timeoutMs = hook.timeoutSec !== undefined && hook.timeoutSec > 0 ? hook.timeoutSec * 1000 : dctx.config.timeoutMs;
      let outcome: HookOutcome;
      try {
        outcome = await dctx.run(hook.command, { ...base, ...specific }, { timeoutMs, projectDir: info.cwd });
      } catch (err) {
        // runHook 永不 reject——此网只接执行器自身 bug；按 fail-open 收账继续
        outcome = { kind: "error", message: `执行器异常：${String(err instanceof Error ? err.message : err)}`, stdout: "", stderr: "", durationMs: 0 };
      }
      await dctx.append("hooks/run", {
        event, hook: hook.command,
        ...(table.matcherSource !== undefined ? { matcher: table.matcherSource } : {}),
        ...(subagent !== undefined ? { subagent: subagent.agentId } : {}),
        status: outcome.kind,
        ...("reason" in outcome && outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        ...("message" in outcome ? { detail: outcome.message } : {}),
        durationMs: outcome.durationMs,
      });
      if (outcome.kind === "deny") {
        // 串行短路：首个 deny 即终局（ZCode 同款）；deny 理由明示给模型（工具行 Error 形态）与用户（toast）
        return { ...result, veto: { deny: true, reason: outcome.reason } };
      }
      if (outcome.kind === "error" || outcome.kind === "timeout") {
        dctx.log.warn("hooks.run.nonblocking", `钩子非阻塞失败（fail-open 继续）`, { event, hook: hook.command, status: outcome.kind });
        continue;
      }
      const decision = outcome.decision;
      if (decision === undefined) continue;
      if (decision.permissionDecision === "deny") {
        const reason = decision.reason ?? "钩子拦截（JSON deny，未给理由）";
        return { ...result, veto: { deny: true, reason } };
      }
      if (decision.decision === "block") {
        // Stop 面：decision block + stopReason/reason（Claude Stop hook 同名形态）
        const reason = decision.stopReason ?? decision.reason ?? "钩子要求继续（未给理由）";
        return { ...result, veto: { deny: true, reason } };
      }
      // permissionDecision "allow"（PreToolUse 无升档 D8；PermissionRequest 代答放行的信号）与
      // "ask"（语义归 T8——按无动作放行）都不折 veto
      if (decision.permissionDecision === "allow") result.allowed = true;
      if (decision.updatedInput !== undefined && event === "PreToolUse") {
        result.updatedInput = decision.updatedInput; // 串行链后写的赢
      }
      if (decision.additionalContext !== undefined) {
        const gated = applyInjectionGates(event, decision.additionalContext, dctx.injectionState);
        if (gated.skipped) {
          await dctx.append("hooks/run", { event, hook: hook.command, status: "skipped-inject-cap" });
        } else if (gated.text !== undefined) {
          result.injections.push(gated.text);
        }
      }
    }
  }
  if (skippedUntrusted > 0) {
    // 待审留痕（每 dispatch 一条；「每会话一次 toast」由宿主侧按 status 去重——T11 接线）
    await dctx.append("hooks/run", { event, status: "skipped-untrusted", detail: `项目层 ${skippedUntrusted} 张表未过信任门整层跳过——/settings 钩子面审查后生效` });
  }
  return result;
}
