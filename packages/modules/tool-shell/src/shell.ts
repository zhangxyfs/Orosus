import { existsSync } from "node:fs";
import { join } from "node:path";

/** 壳解析结果：bash = 显式 Git Bash（win32，POSIX 方言直通）；cmd/sh = spawn shell:true 回落。 */
export type ShellSpec = { kind: "bash"; bashPath: string } | { kind: "cmd" } | { kind: "sh" };

export interface ResolveShellOpts {
  platform?: string; // 缺省 process.platform——测试注入位
  env?: NodeJS.ProcessEnv; // 缺省 process.env——OROSUS_TOOL_SHELL 覆盖 + PATH/ProgramFiles 候选源
  exists?: (p: string) => boolean; // 缺省 existsSync——测试注入位
}

/** win32 壳解析（走查批 2026-09-26 根因：模型命令先验是 POSIX，cmd 下 head/grep 必炸）：
 *  Git Bash 优先（bin\bash.exe 启动自带 /usr/bin 前置，POSIX 命令直通），找不到回落 shell:true（cmd.exe）。
 *  候选序：ProgramFiles → ProgramFiles(x86) → LocalAppData\Programs → scoop → PATH 扫描；
 *  SystemRoot 下 PATH 目录里的 bash.exe 是 WSL 桩（另一个文件系统世界），必须排除。
 *  OROSUS_TOOL_SHELL=cmd 显式锁定回落（测试注入位 + 用户逃生口）；=bash 走探测、探测失败仍回落 cmd。 */
export function resolveShell(opts?: ResolveShellOpts): ShellSpec {
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const exists = opts?.exists ?? existsSync;
  if (platform !== "win32") return { kind: "sh" };
  if (env["OROSUS_TOOL_SHELL"] === "cmd") return { kind: "cmd" };
  const known: [string, string[]][] = [
    ["ProgramFiles", ["Git", "bin", "bash.exe"]],
    ["ProgramFiles(x86)", ["Git", "bin", "bash.exe"]],
    ["LocalAppData", ["Programs", "Git", "bin", "bash.exe"]],
    ["USERPROFILE", ["scoop", "apps", "git", "current", "bin", "bash.exe"]],
  ];
  const candidates: string[] = [];
  for (const [key, segs] of known) {
    const base = env[key];
    if (base) candidates.push(join(base, ...segs));
  }
  const sysRoot = (env["SystemRoot"] ?? "C:\\Windows").toLowerCase();
  for (const dir of (env["PATH"] ?? "").split(";")) {
    const d = dir.trim();
    if (!d || d.toLowerCase().startsWith(sysRoot)) continue; // WSL 桩排除
    candidates.push(join(d, "bash.exe"));
  }
  for (const p of candidates) {
    if (exists(p)) return { kind: "bash", bashPath: p };
  }
  return { kind: "cmd" };
}

/** cmd.exe 缺席的 POSIX 常见命令（护栏黑名单）——不穷举，教学文案给通用规则，模型自纠面自然外扩。 */
const CMD_MISSING = new Set([
  "head", "tail", "grep", "egrep", "fgrep", "sed", "awk", "ls", "cat", "less", "wc",
  "uniq", "tr", "cut", "xargs", "which", "env", "basename", "dirname", "touch",
  "cp", "mv", "rm", "printf", "export", "source", "sleep",
]);

const CMD_SWAP = "替换参考：grep→findstr /I、ls→dir、cat→type、取前 N 行→… | Select-Object -First N（PowerShell）";

/** cmd 方言护栏：壳是 cmd 时 POSIX 命令必炸——执行前拦截并教学，比真实失败省轮次。
 *  先整段挖空引号内容再按管道/链路切段取首词（引号内的 | 不参与切分——不误伤 node -e "a|grep"），
 *  挖空后漏掉的 | 只会「漏拦」不会「误拦」——护栏是教学线不是命令解析器。undefined = 放行。 */
export function lintCmdCommand(command: string): string | undefined {
  const blanked = command.replace(/"[^"]*"|'[^']*'/g, (m) => " ".repeat(m.length));
  const words = new Set<string>();
  for (const seg of blanked.split(/\|\||\||&&|&|;/)) {
    const token = seg
      .trim()
      .split(/\s+/)[0]
      ?.replace(/^["'(]+|["')]$/g, "")
      .toLowerCase();
    if (token && CMD_MISSING.has(token)) words.add(token);
  }
  const devNull = command.includes("/dev/null");
  if (words.size === 0 && !devNull) return undefined;
  let msg = "[未执行——cmd 方言护栏] ";
  if (words.size > 0) msg += `本机 shell 是 cmd.exe，没有 POSIX 命令：${[...words].join("、")}。${CMD_SWAP}。`;
  if (devNull) msg += "检测到 /dev/null：cmd 的空设备是 nul；且别吞 stderr——那是你自纠失败的依据。";
  return msg;
}

/** 第二道线（护栏漏网的「命令不存在」就地翻译）：只认 cmd/bash 的 not-found 文案本身，
 *  普通失败（git fatal 等）不画蛇添足。 */
export function classifyFailure(out: string): string | undefined {
  const cmd = /'([^'\r\n]+)' 不是内部或外部命令/.exec(out);
  if (cmd) {
    return `[命令不存在："${cmd[1]}"——cmd.exe 没有这个命令；POSIX 命令需 Git Bash（已装则本工具自动启用），或改用 cmd/PowerShell 等价命令]`;
  }
  const sh = /(?:^|\n)\s*(?:bash|sh): ([^:\r\n]+): command not found/.exec(out);
  if (sh) return `[命令不存在："${sh[1]}"——本机未安装该命令]`;
  return undefined;
}
