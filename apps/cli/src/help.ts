import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/** CLI 命令补全（M4-2 T21/B5）——readline/promises Completer 形态：返回 [completions, line]
 *  （注意与回调版 readline 的记忆相反——promises 版文档示例即此序；方案草图返回序勘误）。
 *  命令清单 = CLI 拦截层（sessions）+ core 内建 + 模块注册三层全量（两版 /help 并存注记：CLI 拦截后 core 简版被遮蔽）。
 *  @ 文件补全（TUI 批 T6/B18 半项）：行尾 @前缀 → 目录列举前缀过滤（目录候选以 / 结尾——补入后
 *  可继续 Tab；候选上限 20，设计空白登记）；第二参 = @ 匹配段（readline 只替换该段，行首文本不动）。
 *  目录列举失败（不存在/无权限）静默空候选；cwd 注入面供测试（生产缺省 process.cwd()）。 */
export function commandCompleter(line: string, cwd = process.cwd()): [string[], string] {
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
  const all = [
    "/new", "/fork", "/sessions", "/resume", "/title", "/quit", "/exit", "/q",
    "/model", "/status", "/usage", "/reload", "/context", "/paste", "/summary", "/help",
    "/compact", "/permission", "/yolo",
  ];
  return [all.filter((c) => c.startsWith(line)), line];
}

export const HELP_TEXT = `CLI 命令（会话生命周期）：
  /new        开始新会话
  /fork       从当前会话分叉
  /sessions   列出并选择恢复历史会话（别名 /resume）
  /title      给会话命名（别名 /rename）
  /quit       退出（别名 /exit /q）

内建命令（模型与状态）：
  /model      查看或切换当前模型
  /status     显示系统状态
  /usage      显示 token 用量
  /reload     重新加载模块配置
  /context    显示上下文窗口用量
  /paste      粘贴剪贴板图片（或 Alt+V 按键）
  /summary    查看当前生效的压缩摘要
  /help       显示此帮助

模块命令：
  /compact    手动压缩对话历史
  /permission 查看或切换审批模式（rules 子参数看规则清单）
  /yolo       一键切到从不询问（危险命令仍确认）

提示：输入 / 后按 Tab 补全命令名；@ 后 Tab 补全文件；@path#L10-L20 引用行范围`;
