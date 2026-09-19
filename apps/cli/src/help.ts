/** CLI 命令补全（M4-2 T21/B5）——readline/promises Completer 形态：返回 [completions, line]
 *  （注意与回调版 readline 的记忆相反——promises 版文档示例即此序；方案草图返回序勘误）。
 *  命令清单 = CLI 拦截层（sessions）+ core 内建 + 模块注册三层全量（两版 /help 并存注记：CLI 拦截后 core 简版被遮蔽）。 */
export function commandCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
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
  /paste      粘贴剪贴板图片
  /summary    查看当前生效的压缩摘要
  /help       显示此帮助

模块命令：
  /compact    手动压缩对话历史
  /permission 查看或切换审批模式（rules 子参数看规则清单）
  /yolo       一键切到从不询问（危险命令仍确认）

提示：输入 / 后按 Tab 补全命令名`;
