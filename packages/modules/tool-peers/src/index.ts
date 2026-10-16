import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineModule } from "@orosus/contracts/module";
import { z } from "zod";
import { browserBody, browserEntries, browserPage, browserRowText, renderBrowserList, MEMORY_PAGE_SIZE } from "./browser.ts";
import type { BrowserEntry } from "./browser.ts";
import { PeersEnv } from "./env.ts";
import { truncateIndex } from "./memstore.ts";
import { createMemoryTools, createPeersTools } from "./tools.ts";

// 五源导入件对宿主开口（T6d：引导在 apps/cli 直 import 模块包调用——apps 依赖 modules 合法、boundaries 不反向）
export { detectSources, filterNewNotes, importNotes, importNotesProgressive, mergeLegacyMemory, organizeNote, organizeNotes, readSourceNotes } from "./importers.ts";
export type { SourceNote, MemorySource, PeerHomes, LlmStream, LlmStreamReq, OrganizeProgress, MergeLegacyResult } from "./importers.ts";
export { rebuildIndex, writeNoteFile } from "./memstore.ts";   // 走查九：批量落盘路径（每条一文件+索引末次重建）
// T1 桶键件（m5-peers-import-fix）：宿主导入目的地与模块 env.memoryDir 共用同一把键——findGitRoot
// 自 main.ts 下沉（apps 依赖 modules 合法、findGitRoot 反向依赖无门）；encodeCwdLike/记忆桶键见 roots.ts
export { encodeCwdLike, findGitRoot, memoryBucketKey } from "./roots.ts";
// T3/T4 镜像件（m5-peers-import-fix）：四家全桶扫描 + 归属反查（cc/qwen 会话 cwd / zcode db 键匹配 /
// reasonix sessions 反推；G13 冲突与 G14 启发式纪律见 mirror.ts 注释）+ 多桶各归各导入（importMirror）
export { importMirror, scanMirrorSources } from "./mirror.ts";
export type { MirrorBucket, MirrorImportResult } from "./mirror.ts";

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
  // 2026-10-06 走查翻案 D12：默认挂载（原 defaultEnabled:false）——挂载代价仅浏览命令+launcher 登记
  // （不耗 token）；两项模型面功能仍由 v2 双键门控、默认关（D13 缺键 = 关，activate 空转零工具零段）
  launcher: { label: "记忆", command: "/tool-peers__memory", labelKey: "peers.launcher.label" },   // T6e 总览启动器（Ctrl+P）登记——浏览本项目共享记忆；labelKey = 总览行翻译键（2026-10-07 走查）
  mounts: ["contribute:tool", "contribute:command", "contribute:promptSection", "hook:session/start"],
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
        // 首开预热（2026-10-16 用户报障「弹窗慢只在 web 启动后第一次」）：冷 fs/杀软首扫下百级文件
        // 数百 ms——开窗即壳已保窗体秒开，此处再后台只读扫一遍把冷成本挪到会话开启时刻，首次
        // 打开与后续同速。零 UI 零副作用（browserEntries 纯读），失败静默。
        const warmDir = env.memoryDir();
        if (warmDir !== undefined && existsSync(join(warmDir, "MEMORY.md"))) void browserEntries(warmDir).catch(() => {});
      }
    });
    // 记忆浏览窗（T6c，D17：不设开关、不耗 token——模块启用即可用；命令是人用操作面，模型不可调）。
    // 列表 = dialog 控件窗（PopupKey 无选中态，执行期核实走 session-tree__view 同款 interactive list）；
    // 正文 = viewText 全屏 md 渲染（/tasks 纪律）；行模式 ui.dialog 判空降级只读列表。
    ctx.contribute.command("tool-peers__memory", async (_args, ui) => {
      // m5-i18n：浏览窗串走 ctx.t（键住宿主 locales/modules 域，步骤一已备；fallback = 作者缺省中文——
      // approval/compaction 同款模式，2026-10-07 走查接线）
      const t = ctx.t ?? ((k, _params, f) => f ?? k);
      const dir = env.memoryDir();
      // 空态/not-ready 走 notice toast（走查修订一：一句话提示不占面板）；无头无 notice 口回退返回串
      if (dir === undefined) {
        const msg = t("peers.win.notready", undefined, "尚未定位到当前项目会话——先发一条消息建会话，再打开记忆浏览");
        if (ui.notice === undefined) return msg;
        await ui.notice(msg);
        return "";
      }
      // 空仓预检走索引文件存在性（browserEntries 空结果 ⟺ MEMORY.md 缺席——孤儿仅并入非空集）：
      // stat 级检查零成本，空仓照旧走 notice 不开窗；非空才进「开窗即壳后装填」。
      if (!existsSync(join(dir, "MEMORY.md"))) {
        const msg = t("peers.win.empty", undefined, "本项目还没有共享记忆——让模型记一条（tool-peers__memory__write），或先开启工作区记忆");
        if (ui.notice === undefined) return msg;
        await ui.notice(msg);
        return "";
      }
      if (ui.dialog === undefined) {
        // 行模式回落：无交互面翻不了页——仍整表只读列出（分页属控件窗面；无窗壳可先现，同步整表）
        const lines = renderBrowserList(await browserEntries(dir), Date.now(), t);
        ui.viewText?.(t("peers.win.list.fallback", undefined, "记忆 · 本项目（只读列表——全屏模式可 Enter 打开）"), lines.map(browserRowText).join("\n"), { layout: "full" });
        return "";
      }
      // 开窗即壳后装填（2026-10-16 用户走查）：先以装填态开窗（GUI 点击到窗壳零等待），扫描挪到
      // 下一宏任务且走并行异步 stat（慢盘/杀软下串行 statSync 百级文件数百 ms）——开窗帧先行出线，
      // 条目扫完经 handle.update 整窗换入。TUI 同路径（索引驱动扫描毫秒级，装填态一闪即过）。
      let page = 1;
      let loaded: BrowserEntry[] | null = null;   // null = 装填中（onEvent 空转）
      const widgetsOf = () => {
        if (loaded === null) {
          return [{ id: "loading", kind: "text" as const, style: "muted" as const, text: t("peers.win.loading", undefined, "正在装载记忆列表…") }];
        }
        const pg = browserPage(loaded, page, Date.now(), t);
        return [
          { id: "list", kind: "list" as const, interactive: true, items: pg.lines },
          ...(pg.pageCount > 1 ? [{
            id: "pginfo", kind: "text" as const, style: "muted" as const,
            text: t("peers.win.page.info", { page: pg.page, pageCount: pg.pageCount, total: loaded.length }, `第 ${pg.page}/${pg.pageCount} 页 · 共 ${loaded.length} 条`),
          }] : []),
        ];
      };
      const handle = ui.dialog({
        title: t("peers.win.title", undefined, "记忆 · 本项目 —— ↑↓ 选择 · Enter 打开 · Esc 关闭"),
        layout: "center80",   // 2026-10-16 用户口令「占屏幕 80%——全屏太大看着累」（正文 viewText 仍 full——阅读面）
        widgets: widgetsOf(),
        onEvent: (e) => {
          if (loaded === null) return undefined;   // 装填期事件空转（壳上无列表，防御位）
          if (e.type === "activate" && e.id === "list" && e.index !== undefined) {
            const pg = browserPage(loaded, page, Date.now(), t);
            if (pg.hasPrev && e.index === 0) { page = pg.page - 1; handle?.update(widgetsOf()); return undefined; }
            if (pg.hasNext && e.index === pg.lines.length - 1) { page = pg.page + 1; handle?.update(widgetsOf()); return undefined; }
            const entry = loaded[(pg.page - 1) * MEMORY_PAGE_SIZE + (e.index - (pg.hasPrev ? 1 : 0))];
            if (entry === undefined) return undefined;
            const body = browserBody(dir, entry.file);
            handle?.close();   // 正文窗走 viewText FIFO 顶上
            const title = entry.isIndex ? t("peers.win.index.title", undefined, entry.title) : entry.title;
            // back（2026-10-16 用户口令「详情页关闭后返回列表页」）：GUI 关正文窗后回跑本命令重开列表——
            // 取代旧「Esc 返回列表 = 手动重开命令」降级（T7 偏差记档就此销案；预热+快路径下重开≈壳即现）。
            if (body !== undefined) ui.viewText?.(title, body, { layout: "full", markdown: true, back: "/tool-peers__memory" });   // 走查六-③：md 渲染（不支持的宿主按纯文本原样显示）
          }
          return undefined;
        },
      });
      setTimeout(() => { void browserEntries(dir).then((es) => { loaded = es; handle?.update(widgetsOf()); }); }, 0);
      return "";
    });
    // v2 门控注册：双关 = activate 空转（零工具零段零 token；浏览命令不受门控——D17）
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
