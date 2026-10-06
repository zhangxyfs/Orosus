import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineModule } from "@orosus/contracts/module";
import { z } from "zod";
import { PeersEnv } from "./env.ts";
import { truncateIndex } from "./memstore.ts";
import { createMemoryTools, createPeersTools } from "./tools.ts";

/** 模块 config schema（validate.ts:42-46 硬规则——未声明键被 strip，settings 写的开关必须在此声明）。 */
export const configSchema = z.object({
  /** D13 v2 门控两键：默认关（缺键 = 关）。settings「记忆」双开关写盘位（T6b）。 */
  workspaceMemory: z.boolean().default(false),
  sessionPeers: z.boolean().default(false),
  /** 索引段注入开关（workspaceMemory 开启为前提；关 = 段空串零 token）。 */
  injectIndex: z.boolean().default(true),
  windowMinutes: z.number().int().positive().default(10),
  leaseMinutes: z.number().int().positive().default(30),
  /** 测试密封键（HERMETIC：禁碰真实 ~/.orosus）。 */
  sessionsRoot: z.string().optional(),
  memoryBase: z.string().optional(),
});

export default defineModule({
  name: "tool-peers",
  version: "0.1.0",
  description: "会话互相感知——同项目会话占用查询（声明+推导）与共享记忆",
  api: 1,
  defaultEnabled: false, // v2：默认卸载（D12）——走 settings「记忆」双开关启用（T6b）
  mounts: ["contribute:tool", "contribute:promptSection", "hook:session/start"],
  config: configSchema,
  activate(ctx) {
    const cfg = ctx.config as z.infer<typeof configSchema>;
    const env = new PeersEnv(cfg);
    // D26 中途启用补捞：session/start 全仓唯一发射点在会话开启（harness.ts:693），reload 不重放——
    // defaultEnabled:false 的主启用路径恰是会话中途，此时必须按 session.id 扫桶定位自身
    if (env.self === undefined && ctx.session.id !== undefined) env.bootById(ctx.session.id);
    ctx.events.on("session/start", (payload) => {
      const p = payload as { session_id?: string; transcript_path?: string; cwd?: string };
      if (p.session_id !== undefined && p.transcript_path !== undefined && p.cwd !== undefined) {
        env.onSessionStart({ session_id: p.session_id, transcript_path: p.transcript_path, cwd: p.cwd });
      }
    });
    // v2 门控注册：双关 = activate 空转（零工具零段零 token）
    if (cfg.sessionPeers) for (const t of createPeersTools(env, ctx.llm)) ctx.contribute.tool(t);
    if (cfg.workspaceMemory) {
      for (const t of createMemoryTools(env)) ctx.contribute.tool(t);
      ctx.contribute.promptSection({
        order: 5,   // D1：skill=0 之后、todo=10 之前（知识与资源类）
        // getter 活读（AGENTS.md 同款）：内容仅在 MEMORY.md 实际变化时变，稳态不破前缀缓存
        get text() {
          const dir = env.memoryDir();
          if (!cfg.injectIndex || dir === undefined || !existsSync(join(dir, "MEMORY.md"))) return "";
          let raw = "";
          try { raw = readFileSync(join(dir, "MEMORY.md"), "utf8"); } catch { return ""; }
          const t = truncateIndex(raw);
          return `# Shared Project Memory\nIndex of notes saved by sessions of this project. When a line matters to your task, read the full note with tool-peers__memory__read.\n\n${t.text}`;
        },
      });
    }
  },
});
