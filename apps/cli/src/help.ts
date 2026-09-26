import { readdirSync } from "node:fs";
import { resolve } from "node:path";

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
    "/compact", "/permission", "/yolo", "/auto",
  ]; // 批⑤⑥：/usage /status /context /paste 退役出清单（/usage /status 并入 /settings；/paste 由 Alt+V 覆盖；/context 早并入 /settings）；批⑧：/auto 入列；/summary 退役（2026-09-23——查看口 Ctrl+O）；M4-3 T1c：/other 改名 /settings（旧名直接消失）；2026-09-25 /effort 入列
  return [all.filter((c) => c.startsWith(line)), line];
}

export const HELP_TEXT = `CLI 命令（会话生命周期）：
  /new        开始新会话
  /fork       从当前会话分叉
  /sessions   列出并选择恢复历史会话（别名 /resume）
  /title      给会话命名（别名 /rename；引号可选；无参不做任何事）
  /quit       退出（别名 /exit /q）

内建命令（模型与状态）：
  /model      切换当前模型（回答进行中也可执行，下一轮生效）
  /effort     思考投入档位（推理深度/自检/多方案推演；档位来自模型目录；回答进行中也可执行，下一轮生效）
  /reload     重新加载模块配置
  /help       显示此帮助

（压缩摘要查看口 = Ctrl+O——/summary 已退役）

模块命令：
  /compact    手动压缩对话历史
  /permission 查看或切换审批模式（回答进行中也可执行，本轮生效；rules 子参数看规则清单）
  /yolo       一键切到从不询问（批准全自动处理——含危险命令；手写 deny 规则仍拦）
  /auto       从不询问模式（从不打断你，就算有问题也是模型自行判断）

设置与信息面板：
  /settings   设置（磁盘占用 / 上下文用量 / Token 用量 / 运行状态 / 配置网络搜索——/usage /status 已并入；别名 /config）

快捷键（全屏）：
  Enter       发送；回答进行中 = 排队（队列逐条显示在输入框上方，结束后依序发出）
  Ctrl+U      立即注入——排队消息 + 当前输入直接进本轮回答（不等回答结束；命令类不参与）
  Alt+Enter   输入框内换行
  ↑ / ↓       输入框内上下移动光标；光标在起始点再按 ↑ = 召回队尾排队消息 / 上一条历史输入
              （浏览历史时当前草稿自动暂存，↓ 翻回最新即恢复）
  Esc         回答进行中：双击停止生成（单击提示，1 秒内再按生效）；其余：关浮层/菜单
  Tab         输入区 / 模块面板 / 任务面板焦点循环；Shift+Tab 切换权限模式
  Ctrl+T      显示 / 隐藏右侧面板栏
  Ctrl + E    打开模块诊断弹窗——本会话出过问题的模块、失败原因与修复指引（↑↓ 选择 · Enter 详情）
  Alt+E       展开 / 收起思考块（默认收起）
  Alt+O       展开 / 收起工具改动明细（Edit diff / Write 内容，默认 10 行）
  Alt+F       展开 / 收起失败工具的错误详情（默认全收起）
  Alt+V       粘贴剪贴板图片——[image #N] 标记插入输入框光标位，删掉标记即撤销挂图
  Ctrl+A      全选输入框；Shift+←/→ 逐字选择
  PgUp/PgDn   回看上方对话内容；面板聚焦时为面板翻页（运行状态翻模块列表 / 任务清单翻任务）
  ←→ / ↑↓     面板聚焦时生效：←→ 翻运行状态页；↑↓ 选模块 / 任务（Enter 挂/卸载模块）

提示：回答进行中 /new /sessions /provider 回车被拦（尾行提示，回答结束后原文再按回车即发）；图片粘贴用 Alt+V；工具改动（diff）用 Alt+O 展开/收起、失败详情用 Alt+F 展开/收起；压缩摘要用 Ctrl+O 查看；输入 / 后按 Tab 补全命令名；@ 后 Tab 补全文件；@path#L10-L20 引用行范围`;
