import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { HOOK_EVENTS, configSchema, defaultProjectConfigFile, defaultUserConfigFile, loadHooksConfig, type HookEvent, type HooksConfig } from "./config.ts";

export { HOOK_EVENTS, configSchema, defaultProjectConfigFile, defaultUserConfigFile, loadHooksConfig } from "./config.ts";
export type { HookEvent, HooksConfig } from "./config.ts";

/**
 * Hooks 生命周期钩子模块（m5-hooks）。
 * 七事件 shell 命令：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure /
 * Stop / PermissionRequest。协议与 Claude Code 生态兼容（stdin snake_case JSON / 退出码 / stdout JSON），
 * 现成 Claude hooks 脚本零改动可跑。fail-open 铁律：钩子任何失败不阻断主流程（安全兜底是审批系统）。
 * 执行器与逐事件接线在 T5-T8 落地；本骨架先立配置面、监听挂点与运行期闭包。
 */
export default defineModule({
  name: "hooks",
  version: "0.1.0",
  description: "Hooks 生命周期钩子——七事件 shell 命令（用户/项目两层配置、sha256 信任门、注入三道闸、Ctrl+H 注入可见），出厂 required=true",
  api: 1,
  mounts: ["hook:tool/pre-input", "hook:tool/post-execute", "hook:agent/follow-up", "hook:user/prompt-submit", "hook:session/start", "provide"],
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
    const state = { stopContinuations: 0, injectedChars: 0 };
    // T4 骨架：有配置的事件挂监听（dispatch 体在 T5/T6/T7 逐事件充实——当前留痕即放行）
    const dispatch = async (event: HookEvent, _payload: unknown): Promise<undefined> => {
      for (const table of compiled.tables[event] ?? []) {
        for (const hook of table.hooks) {
          await ctx.session.append("hooks/run", { event, hook: hook.command, status: "skeleton", state });
        }
      }
      return undefined;
    };
    const on = (point: string, event: HookEvent): void => { ctx.events.on(point, (p) => dispatch(event, p)); };
    if (has("PreToolUse")) on("tool/pre-input", "PreToolUse");
    if (has("PostToolUse") || has("PostToolUseFailure")) on("tool/post-execute", "PostToolUse");
    if (has("UserPromptSubmit")) on("user/prompt-submit", "UserPromptSubmit");
    if (has("SessionStart")) on("session/start", "SessionStart");
    if (has("Stop")) on("agent/follow-up", "Stop");
    // PermissionRequest 不走挂点订阅——T8 经 provide 服务由 approval 惰性消费
    ctx.provide("hooks.permission-verdict", async () => undefined); // T8 充实（未表态 = undefined 照旧弹窗）
  },
});
