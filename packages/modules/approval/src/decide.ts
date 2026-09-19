import type { Access } from "@orosus/contracts/tool";
import { analyzeDangerous } from "./dangerous.ts";
import { isUnanalyzable } from "./decompose.ts";

/** D36 三档权限模式。 */
export type PermissionMode = "ask-always" | "ask-risky" | "never";

/** 用户细化规则：按工具名/带参 pattern 的 allow/ask/deny（kimi-code user-configured 同款，优先于模式基线）。 */
export interface ApprovalRule {
  effect: "allow" | "ask" | "deny";
  tool: string;
}

export interface DecideInput {
  mode: PermissionMode;
  rules: ApprovalRule[];
  name: string;                // 工具全名，如 "tool-shell__bash"
  approvalRule: string;        // 阶段一声明的规则串，如 "tool-shell__bash(git status)"
  accesses: Access[];
  matchesRule?: (ruleArgs: string) => boolean;
  sessionAllowed: (key: string) => boolean;
}

export type Decision =
  | { effect: "allow"; source: "rule" | "memory" | "mode"; reason: string }
  | { effect: "deny"; source: "rule"; reason: string }
  /** memoryKey = null 表示永不进会话记忆（危险命令）；非 null = "本会话始终允许"的登记键。 */
  | { effect: "ask"; source: "rule" | "mode"; reason: string; memoryKey: string | null };

/** 规则 pattern 三形态：全名 "tool-fs__read" / 后缀通配 "tool-fs__*" / 带参 "tool-shell__bash(git *)"。 */
function parsePattern(pattern: string): { name: string; args?: string } {
  const i = pattern.indexOf("(");
  if (i < 0 || !pattern.endsWith(")")) return { name: pattern };
  return { name: pattern.slice(0, i), args: pattern.slice(i + 1, -1) };
}

const nameMatches = (patternName: string, name: string): boolean =>
  patternName.endsWith("*") ? name.startsWith(patternName.slice(0, -1)) : patternName === name;

function ruleMatches(rule: ApprovalRule, input: DecideInput): boolean {
  const { name, args } = parsePattern(rule.tool);
  if (!nameMatches(name, input.name)) return false;
  if (args === undefined) return true;
  // 带参规则交回工具侧判定（§6.3）；无 matchesRule 的带参规则不匹配——fail-closed
  return input.matchesRule?.(args) === true;
}

/** 从 approvalRule 提取括号内的命令串（无括号返回 null）。 */
export function commandOf(approvalRule: string): string | null {
  const i = approvalRule.indexOf("(");
  return i >= 0 && approvalRule.endsWith(")") ? approvalRule.slice(i + 1, -1) : null;
}

/** 敏感路径集 v1（D36"敏感路径写"）：.env* / secrets* / id_rsa* / *.pem|*.key|*.kdbx / .ssh|.aws|.gnupg 目录 / .git/config。 */
const SENSITIVE_FILE = /^(\.env(\..+)?|secrets?\..+|id_rsa.*|.*\.(pem|key|kdbx))$/;
const SENSITIVE_DIR = /(^|[\\/])\.(ssh|aws|gnupg)([\\/]|$)/;
const GIT_CONFIG = /(^|[\\/])\.git[\\/]config$/;

export function isSensitivePath(p: string): boolean {
  const norm = process.platform === "win32" ? p.toLowerCase() : p;
  const base = norm.split(/[\\/]/).pop() ?? norm;
  return SENSITIVE_FILE.test(base) || SENSITIVE_DIR.test(norm) || GIT_CONFIG.test(norm);
}

const onlyReads = (accesses: Access[]): boolean =>
  accesses.length > 0 && accesses.every((a) => a.kind === "fs.read");

/** 危险命令判定（二轮定案 AST 方案）：三态 verdict——dangerous/unanalyzable 都 fail-closed 询问
 *  （memoryKey=null 永不进会话记忆）；三档均生效（含 never——"从不询问"不含自杀开关，D36 修订）。 */
function dangerousGate(input: DecideInput): Decision | undefined {
  const cmd = commandOf(input.approvalRule);
  if (cmd === null) return undefined;
  const verdict = analyzeDangerous(cmd);
  if (verdict === undefined) {
    // AST 安全后的补集（M4-2 T9）：$/反引号/通配符展开——静态规则匹配不了运行期展开值，保守询问
    if (isUnanalyzable(cmd)) {
      return { effect: "ask", source: "mode", reason: `命令含不可分析模式（变量/通配符/间接执行）：${cmd.slice(0, 80)}`, memoryKey: null };
    }
    return undefined; // 安全
  }
  if (verdict.kind === "dangerous") {
    return { effect: "ask", source: "mode", reason: `危险命令：${verdict.command}`, memoryKey: null };
  }
  return { effect: "ask", source: "mode", reason: `命令无法安全分析（${verdict.kind}）：${cmd.slice(0, 80)}`, memoryKey: null };
}

/** 决策管线：用户规则（配置序，首条命中即止）→ 会话记忆 → 模式基线（D36）。
 *  ask-risky 的 network 按 D36 表字面语义放行（已定案 2026-09-17）——需要收紧用 rules。 */
export function decide(input: DecideInput): Decision {
  for (const rule of input.rules) {
    if (!ruleMatches(rule, input)) continue;
    if (rule.effect === "allow") return { effect: "allow", source: "rule", reason: `规则放行：${rule.tool}` };
    if (rule.effect === "deny") return { effect: "deny", source: "rule", reason: `规则拒绝：${rule.tool}` };
    if (input.sessionAllowed(rule.tool)) return { effect: "allow", source: "memory", reason: `本会话已允许：${rule.tool}` };
    return { effect: "ask", source: "rule", reason: `规则要求询问：${rule.tool}`, memoryKey: rule.tool };
  }

  const dangerous = dangerousGate(input);
  if (dangerous !== undefined) return dangerous; // 三档均如此——含 never（规则优先于危险门：用户显式 allow 是最强意图）

  if (input.mode === "never") return { effect: "allow", source: "mode", reason: "never 模式放行（危险命令除外，D36 修订）" };
  if (input.mode === "ask-always") {
    if (onlyReads(input.accesses)) return { effect: "allow", source: "mode", reason: "ask-always：只读放行" };
    if (input.sessionAllowed(input.approvalRule)) return { effect: "allow", source: "memory", reason: "本会话已允许" };
    return { effect: "ask", source: "mode", reason: "ask-always：非只读操作需确认", memoryKey: input.approvalRule };
  }

  // ask-risky（出厂默认）
  if (input.accesses.some((a) => a.kind === "fs.write" && isSensitivePath(a.path))) {
    const key = `sensitive:${input.name}`;
    if (input.sessionAllowed(key)) return { effect: "allow", source: "memory", reason: "本会话已允许敏感路径写" };
    return { effect: "ask", source: "mode", reason: "敏感路径写入", memoryKey: key };
  }
  if (input.accesses.some((a) => a.kind === "subprocess" || a.kind === "all")) {
    if (input.sessionAllowed(input.approvalRule)) return { effect: "allow", source: "memory", reason: "本会话已允许" };
    return { effect: "ask", source: "mode", reason: "subprocess / 独占执行需确认", memoryKey: input.approvalRule };
  }
  return { effect: "allow", source: "mode", reason: "ask-risky：常规读写放行" };
}
