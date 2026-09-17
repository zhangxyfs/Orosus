/** 危险命令识别（M3 T2，二轮定案 AST 方案）：vendored 纯 TS bash 解析器 + AST 遍历策略
 *  （遍历骨架参照 kimi-code dangerous-command-ask.ts：特权包装/嵌套 shell/eval/busybox/
 *  SIMPLE_DANGEROUS/systemctl/init/dd/rm -rf 判定）。预算 500ms / 1 万节点；
 *  解析失败或降级树（hasError）→ unanalyzable → fail-closed 询问。
 *  Windows 双保险：cmd.exe 方言（del|rd /s 等）bash 语法下多为降级树，另设 cmd 专属 pattern。
 *  正则 v1 保留为兜底路径（parse 不可达时）。 */
import { parse } from "./vendor/tree-sitter-bash/index.ts";

export type DangerousVerdict =
  | { readonly kind: "dangerous"; readonly command: string }
  | { readonly kind: "unanalyzable" };

interface Node {
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly children: readonly Node[];
}

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;
const MAX_NESTED_SHELL_DEPTH = 4;
const UNSAFE_OPERAND = /[$`*?[\]~]/;

const SKIPPED_COMMAND_CHILDREN: ReadonlySet<string> = new Set([
  "variable_assignment",
  "file_redirect",
  "heredoc_redirect",
]);

const SIMPLE_DANGEROUS_COMMANDS: ReadonlySet<string> = new Set([
  "shutdown", "halt", "poweroff", "reboot", "restart-computer", "stop-computer",
  "bcdedit", "diskpart", "format", "mkfs", "wipefs",
]);

const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(["sudo", "doas"]);
const PRIVILEGE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
  "-C", "--close-from", "-T", "--command-timeout", "-U", "--other-user",
  "-r", "--role", "-t", "--type",
]);

const NESTED_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash"]);
const LAUNCH_WRAPPERS: ReadonlySet<string> = new Set(["env", "command", "exec", "nohup", "builtin", "nice"]);
const WRAPPER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "-n", "--adjustment",
]);

const SYSTEMCTL_DANGEROUS_SUBCOMMANDS: ReadonlySet<string> = new Set(["poweroff", "reboot", "halt", "kexec"]);
const SYSTEMCTL_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-H", "--host", "-M", "--machine"]);

const DD_SAFE_DEVICE_TARGETS: ReadonlySet<string> = new Set([
  "/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom",
  "/dev/stdin", "/dev/stdout", "/dev/stderr",
]);

const RM_SAFE_TEMP_ROOTS: readonly string[] = ["/tmp", "/temp"];

/** cmd.exe 专属 pattern（双保险——win32 的 tool-shell 走 cmd 而非 bash）。
 *  参数判定按 token：/s 必须是独立参数（"del C:/single.txt" 的路径段 /s... 不算）。 */
const CMD_DANGEROUS: readonly { name: string; isRisky: (tokens: readonly string[]) => boolean }[] = [
  { name: "del", isRisky: (t) => t.some((arg) => /^\/s$/i.test(arg)) },
  { name: "rd", isRisky: (t) => t.some((arg) => /^\/s$/i.test(arg)) },
  { name: "rmdir", isRisky: (t) => t.some((arg) => /^\/s$/i.test(arg)) },
];

/** 正则 v1 兜底（M3 首版清单——parse 路径完全不可达时使用）。 */
const REGEX_FALLBACK: readonly RegExp[] = [
  /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /git\s+push\s+.*(-f\b|--force\b)/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*f/i,
  /chmod\s+-R\s+777/i,
  /chown\s+-R\b/i,
  /(curl|wget)[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
  /\bsudo\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bformat\b/i,
  /\bmkfs/i,
  /\bdd\s+if=/i,
  /\bshred\b/i,
  /\bwipefs\b/i,
  /\bmkswap\b/i,
];

function isSafeTempRmOperand(operand: string): boolean {
  for (const segment of operand.split("/")) {
    if (segment === "..") return false;
  }
  return RM_SAFE_TEMP_ROOTS.some((root) => operand === root || operand.startsWith(`${root}/`));
}

/** 入口：判定命令串。undefined = 安全；dangerous = 命中；unanalyzable = 无法分析（fail-closed 询问）。 */
export function analyzeDangerous(command: string): DangerousVerdict | undefined {
  const cmd = cmdDialectCheck(command);
  if (cmd !== undefined) return cmd;
  try {
    return analyzeSource(command, 0);
  } catch {
    return regexFallback(command);
  }
}

function cmdDialectCheck(command: string): DangerousVerdict | undefined {
  const tokens = command.trim().split(/\s+/);
  const first = tokens[0]?.toLowerCase() ?? "";
  for (const rule of CMD_DANGEROUS) {
    if (first === rule.name && rule.isRisky(tokens.slice(1))) {
      return { kind: "dangerous", command: `${rule.name} /s` };
    }
  }
  return undefined;
}

function regexFallback(command: string): DangerousVerdict | undefined {
  return REGEX_FALLBACK.some((r) => r.test(command))
    ? { kind: "dangerous", command: command.slice(0, 80) }
    : { kind: "unanalyzable" };
}

function analyzeSource(source: string, depth: number): DangerousVerdict | undefined {
  const parsed = parse(source, PARSE_OPTIONS);
  if (!parsed.ok || parsed.hasError) return { kind: "unanalyzable" };
  const commands: Node[] = [];
  collectCommands(parsed.rootNode as unknown as Node, commands);
  for (const command of commands) {
    const verdict = analyzeCommand(command, depth);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
}

function collectCommands(node: Node, out: Node[]): void {
  if (node.type === "command") out.push(node);
  for (const child of node.children) collectCommands(child, out);
}

function analyzeCommand(command: Node, depth: number): DangerousVerdict | undefined {
  const nameIndex = command.children.findIndex((child) => child.type === "command_name");
  const nameNode = nameIndex >= 0 ? command.children[nameIndex] : undefined;
  const nameWord = nameNode?.children.find((child) => child.isNamed);
  const rawName = nameWord === undefined ? undefined : literalText(nameWord);
  if (rawName === undefined || rawName.length === 0) return { kind: "unanalyzable" };
  const args: string[] = [];
  let dropped = false;
  for (const child of command.children.slice(nameIndex + 1)) {
    if (SKIPPED_COMMAND_CHILDREN.has(child.type)) continue;
    const value = literalText(child);
    if (value === undefined) {
      dropped = true;
    } else if (value.length > 0) {
      args.push(value);
    }
  }
  return analyzeInvocation(normalizeCommandName(rawName), args, dropped, depth);
}

function analyzeInvocation(
  name: string,
  args: readonly string[],
  dropped: boolean,
  depth: number,
): DangerousVerdict | undefined {
  if (PRIVILEGE_WRAPPERS.has(name)) {
    const rest = dropLeadingOptions(args, PRIVILEGE_VALUE_OPTIONS);
    const inner = rest[0];
    if (inner === undefined) return dropped ? { kind: "unanalyzable" } : undefined;
    return analyzeInvocation(normalizeCommandName(inner), rest.slice(1), dropped, depth);
  }
  if (LAUNCH_WRAPPERS.has(name)) {
    const rest = dropLaunchWrapperOperands(name, args);
    const inner = rest[0];
    if (inner === undefined) return dropped ? { kind: "unanalyzable" } : undefined;
    return analyzeInvocation(normalizeCommandName(inner), rest.slice(1), dropped, depth);
  }
  if (NESTED_SHELLS.has(name)) {
    let payloadIndex = -1;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === "--") break;
      if (/^-[a-zA-Z]+$/.test(arg)) {
        if (arg.includes("c")) payloadIndex = i + 1;
      } else {
        break;
      }
    }
    if (payloadIndex < 0) return dropped ? { kind: "unanalyzable" } : undefined;
    const payload = args[payloadIndex];
    if (payload === undefined || depth >= MAX_NESTED_SHELL_DEPTH) return { kind: "unanalyzable" };
    return analyzeSource(payload, depth + 1);
  }
  if (name === "eval") {
    if (args.length === 0) return dropped ? { kind: "unanalyzable" } : undefined;
    if (dropped || depth >= MAX_NESTED_SHELL_DEPTH) return { kind: "unanalyzable" };
    return analyzeSource(args.join(" "), depth + 1);
  }
  if (name === "busybox") {
    const applet = args[0];
    if (applet === undefined || applet.startsWith("-")) return dropped ? { kind: "unanalyzable" } : undefined;
    return analyzeInvocation(normalizeCommandName(applet), args.slice(1), dropped, depth);
  }
  if (SIMPLE_DANGEROUS_COMMANDS.has(name) || name.startsWith("mkfs.")) {
    return { kind: "dangerous", command: name };
  }
  if (name === "init" || name === "telinit") {
    if (args.some((arg) => arg === "0" || arg === "6")) return { kind: "dangerous", command: name };
    return dropped ? { kind: "unanalyzable" } : undefined;
  }
  if (name === "systemctl") {
    const subcommand = dropLeadingOptions(args, SYSTEMCTL_VALUE_OPTIONS)[0];
    if (subcommand !== undefined && SYSTEMCTL_DANGEROUS_SUBCOMMANDS.has(subcommand)) {
      return { kind: "dangerous", command: `systemctl ${subcommand}` };
    }
    return dropped ? { kind: "unanalyzable" } : undefined;
  }
  if (name === "dd") {
    for (const arg of args) {
      if (!arg.startsWith("of=")) continue;
      const target = arg.slice("of=".length);
      if (target.startsWith("/dev/") && !DD_SAFE_DEVICE_TARGETS.has(target)) {
        return { kind: "dangerous", command: "dd" };
      }
    }
    return dropped ? { kind: "unanalyzable" } : undefined;
  }
  if (name === "git") {
    // 正则 v1 清单的保留项（我们比 kimi 骨架多的部分）：不可逆 git 操作
    const sub = args.find((arg) => !arg.startsWith("-"));
    if (sub === "push" && args.some((arg) => /^(-f|--force(=(push|all))?)$/.test(arg))) {
      return { kind: "dangerous", command: "git push --force" };
    }
    if (sub === "reset" && args.includes("--hard")) return { kind: "dangerous", command: "git reset --hard" };
    if (sub === "clean" && args.some((arg) => /^-[a-zA-Z]*f/.test(arg))) return { kind: "dangerous", command: "git clean -f" };
    if (sub === "checkout" && args.includes("--")) {
      // checkout -- <path> 丢弃未提交修改——保守询问（UNSAFE_OPERAND 已过滤通配）
      return dropped ? { kind: "unanalyzable" } : undefined;
    }
    return dropped ? { kind: "unanalyzable" } : undefined;
  }
  if (name === "chmod" || name === "chown") {
    if (args.includes("-R") || args.some((arg) => /^-[a-zA-Z]*R/.test(arg))) {
      return { kind: "dangerous", command: `${name} -R` };
    }
    return dropped ? { kind: "unanalyzable" } : undefined;
  }
  if (name === "rm") {
    let recursive = false;
    let force = false;
    const operands: string[] = [];
    let optionsEnded = false;
    for (const arg of args) {
      if (!optionsEnded && arg === "--") {
        optionsEnded = true;
        continue;
      }
      if (optionsEnded) {
        operands.push(arg);
        continue;
      }
      if (arg === "--recursive") {
        recursive = true;
      } else if (arg === "--force") {
        force = true;
      } else if (/^-[a-zA-Z]+$/.test(arg)) {
        if (/[rR]/.test(arg)) recursive = true;
        if (arg.includes("f")) force = true;
      } else {
        operands.push(arg);
      }
    }
    if (recursive && force) {
      if (!dropped && operands.length > 0 && operands.every(isSafeTempRmOperand)) return undefined;
      return { kind: "dangerous", command: "rm -rf" };
    }
    return dropped ? { kind: "unanalyzable" } : undefined;
  }
  return undefined;
}

function normalizeCommandName(raw: string): string {
  let name = raw;
  const separator = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  if (separator >= 0) name = name.slice(separator + 1);
  name = name.toLowerCase();
  if (name.endsWith(".exe")) name = name.slice(0, -".exe".length);
  return name;
}

function dropLeadingOptions(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return args.slice(i + 1);
    if (arg === "-" || !arg.startsWith("-")) return args.slice(i);
    if (!arg.includes("=") && valueOptions.has(arg)) i += 1;
  }
  return [];
}

function dropLaunchWrapperOperands(name: string, args: readonly string[]): string[] {
  let rest = dropLeadingOptions(args, WRAPPER_VALUE_OPTIONS);
  if (name === "env") {
    let i = rest[0] === "-" ? 1 : 0;
    while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i]!)) i += 1;
    rest = rest.slice(i);
  }
  return rest;
}

function literalText(node: Node): string | undefined {
  switch (node.type) {
    case "word": {
      const raw = node.text;
      if (UNSAFE_OPERAND.test(raw)) return undefined;
      const unescaped = raw.replaceAll(/\\(.)/gs, "$1");
      return UNSAFE_OPERAND.test(unescaped) ? undefined : unescaped;
    }
    case "number":
      return node.text;
    case "raw_string": {
      if (node.text.length < 2) return undefined;
      const value = node.text.slice(1, -1);
      return UNSAFE_OPERAND.test(value) ? undefined : value;
    }
    case "string": {
      let value = "";
      for (const child of node.children) {
        if (child.type === "string_content") {
          value += child.text;
        } else if (child.isNamed) {
          return undefined;
        }
      }
      return UNSAFE_OPERAND.test(value) ? undefined : value;
    }
    default:
      return undefined;
  }
}
