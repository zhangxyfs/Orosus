import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./i18n/app.ts";

/** CLI 命令补全（M4-2 T21/B5）——readline/promises Completer 形态：返回 [completions, line]
 *  （注意与回调版 readline 的记忆相反——promises 版文档示例即此序；方案草图返回序勘误）。
 *  命令清单 = CLI 拦截层（sessions）+ core 内建 + 模块注册三层全量（两版 /help 并存注记：CLI 拦截后 core 简版被遮蔽）。
 *  @ 文件补全（TUI 批 T6/B18 半项）：行尾 @前缀 → 目录列举前缀过滤（目录候选以 / 结尾——补入后
 *  可继续 Tab；候选上限 20，设计空白登记）；第二参 = @ 匹配段（readline 只替换该段，行首文本不动）。
 *  目录列举失败（不存在/无权限）静默空候选；cwd 注入面供测试（生产缺省 process.cwd()）。 */
/** 模块命令补全面（m5 T15 第三职）：名字带 / 前缀 + 可选 completeArg。 */
export interface ModuleCommandSpec {
  name: string; // 含斜杠全形（/note__open）
  completeArg?: (word: string, args: string) => string[];
}

export function commandCompleter(
  line: string,
  cwd = process.cwd(),
  moduleCommands: ModuleCommandSpec[] = [],
  onModuleError?: (name: string, err: unknown) => void,
): [string[], string] {
  if (!line.startsWith("/")) {
    const at = /(?:^|\s)@([^\s]*)$/.exec(line);
    if (at === null) return [[], line];
    const prefix = at[1]!;
    try {
      const slash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
      const dirPart = slash >= 0 ? prefix.slice(0, slash + 1) : "";
      const stem = slash >= 0 ? prefix.slice(slash + 1) : prefix;
      const entries = readdirSync(resolve(cwd, dirPart === "" ? "." : dirPart), { withFileTypes: true });
      const matches = entries
        .filter((e) => e.name.startsWith(stem))
        .map((e) => `@${dirPart}${e.name}${e.isDirectory() ? "/" : ""}`)
        .slice(0, 20);
      return [matches, `@${prefix}`];
    } catch {
      return [[], line];
    }
  }
  // 模块命令参数委托（m5 T15）：行首命令名精确命中声明了 completeArg 的模块命令 → 委托给它补当前词（前缀过滤）；
  // 抛错 = 当无候选（readline 回调节奏里模块异常漏出去是进程级风险——宿主侧 try/catch 兜底）
  const sp = line.indexOf(" ");
  if (sp > 0) {
    const cmd = line.slice(0, sp);
    const args = line.slice(sp + 1);
    const word = args.split(/\s+/).pop() ?? "";
    const m = moduleCommands.find((c) => c.name === cmd && c.completeArg !== undefined);
    if (m !== undefined) {
      try {
        return [m.completeArg!(word, args).filter((x) => x.startsWith(word)), word];
      } catch (err) {
        onModuleError?.(cmd, err);
        return [[], word];
      }
    }
  }
  const all = [
    "/new", "/fork", "/sessions", "/resume", "/title", "/rename", "/quit", "/exit", "/q",
    "/model", "/effort", "/reload", "/help", "/settings", "/config",
    "/compact", "/permission", "/yolo", "/auto", "/tasks", "/btw",
  ]; // 批⑤⑥：/usage /status /context /paste 退役出清单（/usage /status 并入 /settings；/paste 由 Alt+V 覆盖；/context 早并入 /settings）；批⑧：/auto 入列；/summary 退役（2026-09-23——查看口 Ctrl+O）；M4-3 T1c：/other 改名 /settings（旧名直接消失）；2026-09-25 /effort 入列；m5-btw：/btw 入列（与 SLASH_ITEMS 菜单同步）
  return [all.filter((c) => c.startsWith(line)), line];
}

/** m5-i18n T9：HELP_TEXT 改函数——行值（含命令名/对齐/续行）整体住 help 域目录，随表走。 */
export const helpText = (): string => [
	t("help.sec.cli"),
	t("help.cmd.new"),
	t("help.cmd.fork"),
	t("help.cmd.sessions"),
	t("help.cmd.title"),
	t("help.cmd.quit"),
	"",
	t("help.sec.builtin"),
	t("help.cmd.model"),
	t("help.cmd.effort"),
	t("help.cmd.reload"),
	t("help.cmd.help"),
	t("help.cmd.btw"),
	"",
	t("help.note.summary"),
	"",
	t("help.sec.module"),
	t("help.cmd.compact"),
	t("help.cmd.permission"),
	t("help.cmd.yolo"),
	t("help.cmd.auto"),
	"",
	t("help.sec.settings"),
	t("help.cmd.settings"),
	t("help.cmd.tasks"),
	"",
	t("help.sec.skills"),
	t("help.skills.block"),
	t("help.skills.panel"),
	"",
	t("help.sec.hooks"),
	t("help.hooks.panel"),
	t("help.hooks.view"),
	"",
	t("help.sec.keys"),
	t("help.key.enter"),
	t("help.key.ctrlU"),
	t("help.key.altEnter"),
	t("help.key.arrows"),
	t("help.key.esc"),
	t("help.key.tab"),
	t("help.key.ctrlT"),
	t("help.key.ctrlE"),
	t("help.key.altE"),
	t("help.key.altO"),
	t("help.key.altF"),
	t("help.key.altS"),
	t("help.key.altV"),
	t("help.key.ctrlA"),
	t("help.key.pgup"),
	t("help.key.panelNav"),
	"",
	t("help.tips"),
].join("\n");
