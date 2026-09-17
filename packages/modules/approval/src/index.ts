import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { join } from "node:path";
import { decide, type PermissionMode } from "./decide.ts";
import { createPermissionHandler, defaultConfigFile } from "./permission.ts";

const configSchema = z.object({
  mode: z.enum(["ask-always", "ask-risky", "never"]).default("ask-risky"),
  rules: z.array(z.object({
    effect: z.enum(["allow", "ask", "deny"]),
    tool: z.string().min(1).describe("工具 pattern：全名 / 后缀通配 tool-fs__* / 带参 tool-shell__bash(git *)"),
  })).default([]),
  configFile: z.string().optional().describe("/permission 模式写回的用户层配置（缺省 ~/.orosus/config.toml）"),
  projectConfigFile: z.string().optional().describe("生效层判定的项目层配置路径（缺省 <cwd>/.orosus/config.toml；含 [approval] 节时模式写项目层，五轮 P1）"),
});

/** waterfall 载荷形状（core registry 产出，D40 增 matchesRule）。 */
interface PreExecutePayload {
  callId: string;
  name: string;
  args?: unknown;
  accesses: { kind: string; path?: string; host?: string }[];
  approvalRule: string;
  matchesRule?: (ruleArgs: string) => boolean;
}

export default defineModule({
  name: "approval",
  version: "0.1.0",
  description: "审批/权限模块——tool/pre-execute waterfall 首个消费方（D36 三档 + 规则链 + 会话记忆，出厂 required=true）",
  api: 1,
  mounts: ["hook:tool/pre-execute", "contribute:command"],
  config: configSchema,
  logEvents: ["approval/requested", "approval/resolved"],
  activate(ctx) {
    const cfg = ctx.config as z.infer<typeof configSchema>;
    const state = {
      modeOverride: undefined as PermissionMode | undefined, // /permission 运行期覆盖——命令与 waterfall 同闭包共享，选档即生效
      sessionMemory: new Set<string>(),                       // "本会话始终允许"（会话结束失效，不落配置）
    };
    let askChain: Promise<unknown> = Promise.resolve();       // FIFO 串行化：并行工具组内的询问逐个发起（readline 非并发安全）

    ctx.events.on("tool/pre-execute", async (payload) => {
      const p = payload as PreExecutePayload;
      const d = decide({
        mode: state.modeOverride ?? cfg.mode,
        rules: cfg.rules,
        name: p.name,
        approvalRule: p.approvalRule,
        accesses: p.accesses as never,
        ...(p.matchesRule !== undefined ? { matchesRule: p.matchesRule } : {}),
        sessionAllowed: (k) => state.sessionMemory.has(k),
      });
      if (d.effect === "allow") {
        ctx.log.debug("approval.allow", "放行", { callId: p.callId, name: p.name, source: d.source });
        return undefined;
      }
      if (d.effect === "deny") {
        ctx.session.append("approval/resolved", { callId: p.callId, name: p.name, decision: "deny", source: d.source, reason: d.reason });
        ctx.log.info("approval.deny", "规则拒绝", { callId: p.callId, name: p.name, rule: d.reason });
        return { deny: true, reason: `审批拒绝（${d.reason}）` };
      }
      // ask：请求先落日志（UI 经日志投影看到，§6.7），询问经 ctx.ui（D35 M3：waterfall 侧交互口）
      ctx.session.append("approval/requested", {
        callId: p.callId, name: p.name, approvalRule: p.approvalRule,
        reason: d.reason, mode: state.modeOverride ?? cfg.mode,
      });
      const ask = async (): Promise<{ deny: true; reason: string } | undefined> => {
        const items = d.memoryKey === null ? ["批准一次", "拒绝"] : ["批准一次", "本会话始终允许", "拒绝"];
        const title = [
          "工具执行确认",
          `工具：${p.name}`,
          `规则：${p.approvalRule}`,
          `访问：${p.accesses.map((a) => a.kind).join(", ")}`,
          `原因：${d.reason}`,
        ].join("\n");
        const choice = await ctx.ui.choose(title, items);
        if (choice === "拒绝") {
          ctx.session.append("approval/resolved", { callId: p.callId, name: p.name, decision: "deny", source: "user" });
          ctx.log.info("approval.deny", "用户拒绝", { callId: p.callId, name: p.name });
          return { deny: true, reason: `用户拒绝执行 ${p.name}（${d.reason}）` };
        }
        if (choice === "本会话始终允许" && d.memoryKey !== null) state.sessionMemory.add(d.memoryKey);
        ctx.session.append("approval/resolved", {
          callId: p.callId, name: p.name,
          decision: choice === "本会话始终允许" ? "allow-session" : "allow-once",
        });
        ctx.log.info("approval.allow", choice === "本会话始终允许" ? "用户批准（本会话）" : "用户批准（一次）", { callId: p.callId, name: p.name });
        return undefined;
      };
      const run = askChain.then(ask, ask);
      askChain = run.then(() => undefined, () => undefined);
      return run;
    });

    // /permission（D36/D38：内建别名 /permission → approval__permission）——选档闭包 override 即时生效 + 写生效层持久化
    ctx.contribute.command("approval__permission", createPermissionHandler({
      current: () => state.modeOverride ?? cfg.mode,
      apply: (next) => { state.modeOverride = next; },
      rules: () => cfg.rules,
      configPath: cfg.configFile ?? defaultConfigFile(),
      projectConfigPath: cfg.projectConfigFile ?? join(process.cwd(), ".orosus", "config.toml"), // 生效层判定（五轮 P1）
    }));
  },
});