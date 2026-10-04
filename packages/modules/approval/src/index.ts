import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { join } from "node:path";
import { commandOf, decide, type PermissionMode } from "./decide.ts";
import { decomposeCommand } from "./decompose.ts";
import { createAutoHandler, createPermissionHandler, createYoloHandler, defaultConfigFile, persistAllowRule } from "./permission.ts";

const configSchema = z.object({
  mode: z.enum(["ask-always", "ask-risky", "never"]).default("ask-risky"),
  rules: z.array(z.object({
    effect: z.enum(["allow", "ask", "deny"]),
    tool: z.string().min(1).describe("工具 pattern：全名 / 后缀通配 tool-fs__* / 带参 tool-shell__bash(git *)"),
  })).default([]),
  configFile: z.string().optional().describe("/permission 模式写回的用户层配置（缺省 ~/.orosus/config.toml）"),
  projectConfigFile: z.string().optional().describe("生效层判定的项目层配置路径（缺省 <cwd>/.orosus/config.toml；含 [approval] 节时模式写项目层，五轮 P1）"),
});

/** waterfall 载荷形状（core registry 产出，D40 增 matchesRule；M4.5 子代理批增 mode/subagent——
 *  mode = 子代理转发给的档提示（需要时候询问语义），subagent = 派单方身份（后台挂起审批用）。 */
interface PreExecutePayload {
  callId: string;
  name: string;
  args?: unknown;
  accesses: { kind: string; path?: string; host?: string }[];
  approvalRule: string;
  matchesRule?: (ruleArgs: string) => boolean;
  mode?: import("./decide.ts").PermissionMode;
  subagent?: {
    agentId: string; depth: 1 | 2; parentId?: string; background: boolean; label: string;
    /** 后台 Ask 档挂起审批（M4.5 T8 / 决策 3）：不抢占——park 登记待批，用户有空再答；被停自动按拒绝收场。 */
    park?: (info: { tool: string; reason: string }) => Promise<boolean>;
  };
}

export default defineModule({
  name: "approval",
  version: "0.1.0",
  description: "审批/权限模块——tool/pre-execute waterfall 首个消费方（D36 三档 + 规则链 + 会话记忆，出厂 required=true）",
  api: 1,
  mounts: ["hook:tool/pre-execute", "contribute:command", "provide"],
  provides: ["approval.current-mode"],
  config: configSchema,
  logEvents: ["approval/requested", "approval/resolved", "approval/policy"],
  activate(ctx) {
    const cfg = ctx.config as z.infer<typeof configSchema>;
    const state = {
      modeOverride: undefined as PermissionMode | undefined, // /permission 运行期覆盖——命令与 waterfall 同闭包共享，选档即生效
      sessionMemory: new Set<string>(),                       // "本会话始终允许"（会话结束失效，不落配置）
    };
    let askChain: Promise<unknown> = Promise.resolve();       // FIFO 串行化：并行工具组内的询问逐个发起（readline 非并发安全）

    // 运行期档读口（M4.5 子代理批——服务倒挂）：内核子代理缝解析「跟随主对话」时运行期取（覆盖 > 配置）
    ctx.provide("approval.current-mode", () => state.modeOverride ?? cfg.mode);

    ctx.events.on("tool/pre-execute", async (payload) => {
      const p = payload as PreExecutePayload;
      // 分段匹配包装（M4-2 T9，approval 侧——不动 tool-shell 的 matchesRule）：复合命令须每段都命中
      // 规则前缀才放行——`git status; rm -rf /` 这类危险尾巴不再搭 `bash(git *)` 的车（fail-closed）。
      const segs = decomposeCommand(commandOf(p.approvalRule) ?? "");
      const matchesRule = p.matchesRule !== undefined
        ? (ruleArgs: string, effect: "allow" | "ask" | "deny"): boolean => {
            if (!p.matchesRule) return false;
            if (segs.length === 0) {
              // MA-01 修复（2026-09-28 code review P1）：不可分段命令（$/反引号/eval/xargs/-c——静态前缀
              // 匹配不了运行期展开值）不许搭 allow/ask 规则的便车短路危险门（旧实现 `git $(evil)` 命中
              // allow bash(git *) 零询问执行）；deny 保留朴素判定——拦多是安全方向，never 档「手写 deny
              // 仍拦」承诺不破
              return effect === "deny" && p.matchesRule(ruleArgs) === true;
            }
            const ruleSegs = decomposeCommand(ruleArgs);
            if (ruleSegs.length > 1) {
              // 复合规则（⑩ 生成的 bash(seg1 && seg2)）：段列全等才命中
              return ruleSegs.length === segs.length && ruleSegs.every((rs, i) => rs === segs[i]);
            }
            // MA-02/03：段为完整文本——`bash(git push *)` 命中 `git push origin main`，
            // `bash(npm test)` 不再误吞 `npm test --watch`。MA-04 配套：前缀匹配按词边界
            //（`${seg} ` 补尾空格）——裸命令 `git status` 也命中 `bash(git status *)`，且
            // `git statusfoo` 这类同前缀异词不误中
            const prefix = ruleArgs.endsWith("*") ? ruleArgs.slice(0, -1) : null;
            return segs.every((seg) => prefix !== null ? `${seg} `.startsWith(prefix) : seg === ruleArgs);
          }
        : undefined;
      const d = decide({
        // M4.5 子代理批 + CX-01/02 修复（2026-09-28）：载荷档 = 子代理侧解析出的转发档——auto → never
        //（规则链先于基线：手写 deny/ask 对子代理照常生效，基线不自发弹窗）、ask → 主对话真实运行期档与
        // ask-risky 地板取严（主对话更严档不再被降档）；无提示 = 主对话原路径不变
        mode: p.mode ?? state.modeOverride ?? cfg.mode,
        rules: cfg.rules,
        name: p.name,
        approvalRule: p.approvalRule,
        accesses: p.accesses as never,
        ...(matchesRule !== undefined ? { matchesRule } : {}),
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
      // 后台子代理的 ask（决策 3 第二层）：不弹窗不抢占——park 挂起（花名册记待批，用户有空再答）；
      // 前台子代理与主对话照旧走 ctx.ui 串行队列。park 返回 false（被停自动回绝）= 拒绝收场。
      if (d.effect === "ask" && p.subagent?.background === true && p.subagent.park !== undefined) {
        ctx.session.append("approval/requested", {
          callId: p.callId, name: p.name, approvalRule: p.approvalRule,
          reason: d.reason, mode: p.mode ?? state.modeOverride ?? cfg.mode,
          subagent: p.subagent.label, background: true,
        });
        const allowed = await p.subagent.park({ tool: p.name, reason: d.reason });
        ctx.session.append("approval/resolved", {
          callId: p.callId, name: p.name,
          decision: allowed ? "allow-once" : "deny",
          source: allowed ? "user" : "auto-deny",
          ...(allowed ? {} : { reason: "后台子代理被停止——未答审批按拒绝收场" }),
        });
        if (!allowed) return { deny: true, reason: `后台子代理审批未通过（${p.name}——被停止自动回绝或用户拒绝）` };
        return undefined;
      }
      // hooks 代答（m5-hooks T8，服务倒挂 + 调用期惰性）：前台 ask 弹窗前消费 hooks.permission-verdict——
      // deny 直接拒绝 / allow 跳过弹窗放行（allow 升档效力只在此成立），approval/requested·resolved 带
      // 「hooks 代答」因；未表态/未装 hooks 模块（getOptional undefined）照旧弹窗。dangerousGate 的 ask
      //（source:"mode"）同样代答；never 档不进 ask 分支故不触发（注记不修）。headless 下 verdictFn 抛错
      // 按 undefined 处理——代答失败回落弹窗（弹窗在 headless 会抛「无交互环境」，fail-closed 不减损）。
      if (d.effect === "ask") {
        const verdictFn = await ctx.services.getOptional("hooks.permission-verdict" as import("@orosus/contracts/module").CapabilityKey<(info?: { toolName: string; toolInput?: unknown; subagent?: string }) => Promise<{ verdict: "allow" | "deny"; reason?: string } | undefined>>);
        if (typeof verdictFn === "function") {
          let verdict: { verdict: "allow" | "deny"; reason?: string } | undefined;
          try {
            verdict = await verdictFn({ toolName: p.name, toolInput: p.args, ...(p.subagent !== undefined ? { subagent: p.subagent.label } : {}) });
          } catch {
            verdict = undefined;
          }
          if (verdict !== undefined) {
            ctx.session.append("approval/requested", {
              callId: p.callId, name: p.name, approvalRule: p.approvalRule,
              reason: d.reason, mode: p.mode ?? state.modeOverride ?? cfg.mode,
              ...(p.subagent !== undefined ? { subagent: p.subagent.label } : {}),
              hooksVerdict: verdict.verdict,
            });
            ctx.session.append("approval/resolved", {
              callId: p.callId, name: p.name,
              decision: verdict.verdict === "allow" ? "allow-once" : "deny",
              source: "hooks",
              ...(verdict.verdict === "deny" && verdict.reason !== undefined ? { reason: verdict.reason } : {}),
            });
            if (verdict.verdict === "deny") return { deny: true, reason: `钩子代答拒绝${verdict.reason !== undefined ? `（${verdict.reason}）` : ""}` };
            return undefined; // allow：跳过弹窗放行
          }
        }
      }
      // ask：请求先落日志（UI 经日志投影看到，§6.7），询问经 ctx.ui（D35 M3：waterfall 侧交互口）
      ctx.session.append("approval/requested", {
        callId: p.callId, name: p.name, approvalRule: p.approvalRule,
        // MA-09 修复（2026-09-28 code review）：前台路径对齐后台（98 行）记 p.mode——M4.5 加子代理转发
        // 档时只更新了后台分支，前台事件丢档提示致日志投影与实际生效档不一致
        reason: d.reason, mode: p.mode ?? state.modeOverride ?? cfg.mode,
      });
      const ask = async (): Promise<{ deny: true; reason: string } | undefined> => {
        // 第四选「始终允许（写规则落盘）」（M4-2 T9）：仅可分段命令提供（不可分段/危险 → 与现状同视觉）
        const offerPersist = d.memoryKey !== null && segs.length > 0;
        const items = d.memoryKey === null
          ? ["批准一次", "拒绝"]
          : offerPersist
            ? ["批准一次", "本会话始终允许", "始终允许（写规则落盘）", "拒绝"]
            : ["批准一次", "本会话始终允许", "拒绝"];
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
        if (choice === "始终允许（写规则落盘）" && offerPersist) {
          // 规则生成：单段 → bash(<段1> *)——MA-04 收窄一档（2026-09-28 拍板，推翻旧走查「首词全家放行」定案）：
          // 批准 git status 落 bash(git status *)——同命令带参数不再问，换子命令（git push）仍会问；
          // 多段 → 单条 bash(<段1> && <段2>) 段列原样（复合精确）——写生效层 + 会话内即时生效
          const pattern = segs.length === 1 ? `${p.name}(${segs[0]!} *)` : `${p.name}(${segs.join(" && ")})`;
          try {
            // MA-10 修复（2026-09-28 code review）：落盘结果回传——盘上同 pattern 异 effect（deny/ask）规则
            // 在时不写不 push（会话内 push 的 allow 会被配置序首条命中的既有规则压住，且层间规则集不一致、
            // 重启后行为反转），warn 提示用户处理冲突；盘上同 pattern allow = 幂等成功（不重复写，会话照常生效）
            const persisted = persistAllowRule(cfg.configFile ?? defaultConfigFile(), pattern, cfg.projectConfigFile ?? join(process.cwd(), ".orosus", "config.toml"));
            if (persisted.added || persisted.existingEffect === "allow") {
              cfg.rules.push({ effect: "allow", tool: pattern }); // 本会话即时生效（盘上规则 reload 后复检）
              ctx.log.info("approval.rule.persisted", persisted.added ? "始终允许规则已落盘" : "同 pattern allow 规则已在盘，无需重复落盘", { callId: p.callId, pattern });
            } else {
              ctx.log.warn("approval.rule.conflict", `盘上已存在同 pattern 的 ${persisted.existingEffect} 规则，allow 未落盘——请在生效层 [approval] rules 处理冲突`, { callId: p.callId, pattern, existingEffect: persisted.existingEffect });
            }
          } catch (err) {
            ctx.log.warn("approval.rule.persist-failed", "规则落盘失败（本次仍仅会话级放行）", { callId: p.callId, error: String(err) });
            if (d.memoryKey !== null) state.sessionMemory.add(d.memoryKey); // 落盘失败回退会话记忆，不白选
          }
        }
        ctx.session.append("approval/resolved", {
          callId: p.callId, name: p.name,
          decision: choice === "本会话始终允许" || choice === "始终允许（写规则落盘）" ? "allow-session" : "allow-once",
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
      apply: (next) => {
        state.modeOverride = next;
        ctx.session.append("approval/policy", { mode: next }); // 切换落日志（dsh 同款，M4-2 T9）
      },
      rules: () => cfg.rules,
      configPath: cfg.configFile ?? defaultConfigFile(),
      projectConfigPath: cfg.projectConfigFile ?? join(process.cwd(), ".orosus", "config.toml"), // 生效层判定（五轮 P1）
    }));
    // /yolo（2026-09-26 拍板 D2 交叉互换，2026-09-28 落地）：一键 ask-risky——apply 复用 permission 的闭包（policy 事件随之落）
    ctx.contribute.command("approval__yolo", createYoloHandler({
      apply: (next) => {
        state.modeOverride = next;
        ctx.session.append("approval/policy", { mode: next });
      },
      configPath: cfg.configFile ?? defaultConfigFile(),
      projectConfigPath: cfg.projectConfigFile ?? join(process.cwd(), ".orosus", "config.toml"),
    }));
    // /auto（2026-09-26 拍板 D1：/auto==从不询问，kimi auto 语义）：一键 never（2026-09-28 落地换绑，此前行为是 ask-risky）
    ctx.contribute.command("approval__auto", createAutoHandler({
      apply: (next) => {
        state.modeOverride = next;
        ctx.session.append("approval/policy", { mode: next });
      },
      configPath: cfg.configFile ?? defaultConfigFile(),
      projectConfigPath: cfg.projectConfigFile ?? join(process.cwd(), ".orosus", "config.toml"),
    }));
  },
});