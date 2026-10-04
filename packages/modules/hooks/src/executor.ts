import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/* ── 壳解析（拷贝自 packages/modules/tool-shell/src/shell.ts:18-45 resolveShell——铁律 2：模块只能
 * import @orosus/contracts，无法 import tool-shell；本拷贝与其保持探测口径同步：Git Bash 优先、
 * 找不到回落 shell:true（cmd.exe），Unix 恒 sh。OROSUS_TOOL_SHELL=cmd 显式锁定。）────────── */
export type ShellSpec = { kind: "bash"; bashPath: string } | { kind: "cmd" } | { kind: "sh" };

export function resolveShell(opts?: { platform?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean }): ShellSpec {
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
    if (!d || d.toLowerCase().startsWith(sysRoot)) continue; // SystemRoot 下 PATH 里的 bash.exe 是 WSL 桩，排除
    candidates.push(join(d, "bash.exe"));
  }
  for (const p of candidates) {
    if (exists(p)) return { kind: "bash", bashPath: p };
  }
  return { kind: "cmd" };
}

/** 杀进程树（win32 = taskkill /T /F——Windows 纪律；Unix = 进程组 SIGKILL，spawn 须 detached）。
 *  tool-shell killTree 的完整版（快照+清扫）是交互路径收尾的讲究；钩子是短命令，简洁版够用。 */
const killTree = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => { child.kill("SIGKILL"); });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
};

/** stdout/stderr 采集帽：各 64KB/流。采集帽先于 JSON 解析、与注入帽（16k 字符）解耦——16k 字符注入经
 *  JSON 转义最坏约 ×2 ≈32KB，32KB 采集帽会把大 additionalContext 的 JSON 截断致解析失败、按非阻塞
 *  错误静默丢注入（2026-10-04 三补查修的自埋雷；64KB 留足余量）。 */
const CAPTURE_CAP = 64 * 1024;
const collect = (stream: NodeJS.ReadableStream): { text: string; truncated: boolean } => {
  let text = "";
  let truncated = false;
  stream.on("data", (d: Buffer) => {
    if (text.length >= CAPTURE_CAP) { truncated = true; return; }
    text += d.toString("utf8");
    if (text.length > CAPTURE_CAP) { text = text.slice(0, CAPTURE_CAP); truncated = true; }
  });
  return { get text() { return text; }, get truncated() { return truncated; } };
};

/** 环境变量策略（六补注修）：继承宿主环境 + 剔除敏感键 + 叠加注入——清空环境会静默弄死依赖 PATH 的
 *  实用脚本（superpowers 的 cat/dirname）。剔除 = 变量名含 TOKEN/KEY/SECRET/PASSWORD（大小写不敏感
 *  包含匹配；codex 实为精确整名名单，四关键词包含系本批自创放宽——过宽误伤面已登记设计空白表，走查期
 *  按实损收紧）。双发 CLAUDE_PROJECT_DIR 白得生态脚本兼容。 */
const SENSITIVE_NAME = /TOKEN|KEY|SECRET|PASSWORD/i;
export function buildHookEnv(projectDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SENSITIVE_NAME.test(k)) continue;
    out[k] = v;
  }
  out["OROSUS_PROJECT_DIR"] = projectDir;
  out["CLAUDE_PROJECT_DIR"] = projectDir;
  return out;
}

/** 命令串模板展开：${OROSUS_PROJECT_DIR} / ${CLAUDE_PROJECT_DIR} → 项目绝对路径（replacer 函数形态
 *  防 $& 等替换特殊串注入）。 */
export function expandCommand(command: string, projectDir: string): string {
  return command
    .replace(/\$\{OROSUS_PROJECT_DIR\}/g, () => projectDir)
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, () => projectDir);
}

/** stdout JSON 决策（loose 校验——只认已知字段，其余忽略）：顶层字段与 hookSpecificOutput 内字段
 *  同级展开（Claude 生态两种形态并存；additional_context 蛇形是 superpowers polyglot 第三形态）。
 *  形似非 JSON / 解析失败 → undefined（非阻塞面由调用方处置）。 */
export interface HookDecision {
  permissionDecision?: "allow" | "deny" | "ask";
  decision?: string;            // Stop 面："block" | "approve"（Claude 同名）
  updatedInput?: unknown;       // PreToolUse 改参
  additionalContext?: string;   // 注入上下文
  reason?: string;              // deny/block 理由
  stopReason?: string;          // Stop 续跑理由（Claude 同名）
}

export function parseHookJson(stdout: string): HookDecision | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const specific = src["hookSpecificOutput"];
  const inner = typeof specific === "object" && specific !== null && !Array.isArray(specific) ? specific as Record<string, unknown> : {};
  const flat: Record<string, unknown> = { ...inner, ...src }; // 同名冲突顶层赢（病理形态，无实义）
  const str = (k: string): string | undefined => (typeof flat[k] === "string" ? flat[k] as string : undefined);
  const out: HookDecision = {};
  const pd = str("permissionDecision");
  if (pd === "allow" || pd === "deny" || pd === "ask") out.permissionDecision = pd;
  const d = str("decision");
  if (d !== undefined) out.decision = d;
  if (flat["updatedInput"] !== undefined) out.updatedInput = flat["updatedInput"];
  const ac = str("additionalContext") ?? str("additional_context");
  if (ac !== undefined) out.additionalContext = ac;
  const reason = str("reason");
  if (reason !== undefined) out.reason = reason;
  const stopReason = str("stopReason");
  if (stopReason !== undefined) out.stopReason = stopReason;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 钩子执行结果四态：pass / deny（阻断）/ error（非阻塞失败——fail-open 铁律）/ timeout。 */
export type HookOutcome =
  | { kind: "pass"; decision?: HookDecision; stdout: string; stderr: string; durationMs: number }
  | { kind: "deny"; reason: string; decision?: HookDecision; stdout: string; stderr: string; durationMs: number }
  | { kind: "error"; message: string; stdout: string; stderr: string; durationMs: number }
  | { kind: "timeout"; durationMs: number };

export interface RunHookOpts {
  timeoutMs: number;
  projectDir: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv; // 缺省 process.env——测试注入位
  shell?: ShellSpec;       // 缺省 resolveShell()——测试注入位
}

/** 单钩子执行：spawn（win32 bash 分支显式 argv、cmd/sh 分支 shell:true——tool-shell index.ts:51-52 同款）；
 *  stdin 喂一行 snake_case JSON；退出码折算 0=放行 / 2=阻断（stdout 合法 JSON 决策优先）/ 其他非零=非阻塞错误。
 *  退出码 2 的 reason 取 stderr 优先、空则 stdout。永不 reject（结果带内）。 */
export function runHook(command: string, payload: Record<string, unknown>, opts: RunHookOpts): Promise<HookOutcome> {
  const shell = opts.shell ?? resolveShell();
  const startedAt = Date.now();
  return new Promise((resolveP) => {
    let child: ChildProcess;
    try {
      const expanded = expandCommand(command, opts.projectDir);
      const env = buildHookEnv(opts.projectDir, opts.env);
      const cwd = opts.cwd ?? opts.projectDir;
      child = shell.kind === "bash"
        ? spawn(shell.bashPath, ["-c", expanded], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: false })
        : spawn(expanded, { shell: true, cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (err) {
      resolveP({ kind: "error", message: `钩子进程未启动：${err instanceof Error ? err.message : String(err)}`, stdout: "", stderr: "", durationMs: Date.now() - startedAt });
      return;
    }
    const out = collect(child.stdout!);
    const err = collect(child.stderr!);
    let settled = false;
    const finish = (r: HookOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ kind: "timeout", durationMs: Date.now() - startedAt });
    }, opts.timeoutMs);
    child.on("error", (e) => { finish({ kind: "error", message: `钩子进程错误：${e.message}`, stdout: out.text, stderr: err.text, durationMs: Date.now() - startedAt }); });
    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      const decision = parseHookJson(out.text);
      if (code === 0) {
        finish({ kind: "pass", ...(decision !== undefined ? { decision } : {}), stdout: out.text, stderr: err.text, durationMs });
        return;
      }
      if (code === 2) {
        // exit 2 = 「阻断+读 stderr」简写；stdout JSON 是完整决策面——两者同到以 JSON 为准
        //（JSON 明示 allow 时放行、明示 deny 用 JSON reason；无决策字段回落 exit-2 默认 deny）
        if (decision?.permissionDecision === "allow") {
          finish({ kind: "pass", decision, stdout: out.text, stderr: err.text, durationMs });
          return;
        }
        const stderrReason = err.text.trim();
        const stdoutTextReason = out.text.trim() !== "" && decision === undefined ? out.text.trim() : "";
        const fallback = (stderrReason !== "" ? stderrReason : stdoutTextReason) || "钩子阻断（exit 2，未给理由）";
        const reason = decision?.reason ?? decision?.stopReason ?? fallback;
        finish({ kind: "deny", reason, ...(decision !== undefined ? { decision } : {}), stdout: out.text, stderr: err.text, durationMs });
        return;
      }
      finish({ kind: "error", message: `钩子退出码 ${String(code)}${err.text.trim() !== "" ? `：${err.text.trim()}` : ""}`, stdout: out.text, stderr: err.text, durationMs });
    });
    try {
      child.stdin!.write(`${JSON.stringify(payload)}\n`);
      child.stdin!.end();
    } catch { /* stdin 已关（进程速死）——close 路照常收尾 */ }
  });
}

/* ── 注入出口三道闸（执行器统一执行——2026-10-04 三补查定）────────────────────────────── */

/** 单条注入帽：16,000 字符（additionalContext 与 Stop 续跑 reason 同帽），可读截断标记（Reasonix 式，
 *  不用裸 ...）。 */
export const INJECT_SINGLE_CAP = 16_000;
/** 会话累计帽：64,000 字符（超限后本会话不再注入——防慢刀子塞爆上下文；对齐 promptSection 全局
 *  64KB 预算精神）。 */
export const INJECT_SESSION_CAP = 64_000;

/** 净化：剥 ANSI/VT 转义序列（CSI/OSC）与 C0/C1 控制字符（qwen stripAnsiAndControl 同款，全场唯一
 *  先例）——保留 \t \n \r（注入正文是自然语言，换行合法）。 */
export function stripAnsiAndControl(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")   // CSI 序列（ESC [ … 终字节）
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g, "") // OSC 序列（ESC ] … BEL/ST）
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ""); // C0（保留 \t\n\r）+ DEL + C1
}

export interface InjectionState {
  injectedChars: number; // 会话累计（模块闭包持有，reload 重置）
}

export interface GateResult {
  text?: string;        // 过闸后的注入正文（已净化+截断+包裹）；skipped 时缺席
  skipped: boolean;     // 会话累计超帽——本条不注入（调用方 toast 一次 + hooks/run 落账）
  truncated: boolean;   // 单条截断发生
}

/** 三道闸（顺序：净化 → 单条帽 → 累计帽）+ 固定包裹头尾——注入正文里伪造同款头无法越过包裹层。 */
export function applyInjectionGates(event: string, raw: string | undefined, state: InjectionState): GateResult {
  if (raw === undefined || raw === "") return { skipped: true, truncated: false };
  const cleaned = stripAnsiAndControl(raw);
  let body = cleaned;
  let truncated = false;
  if (body.length > INJECT_SINGLE_CAP) {
    body = `${body.slice(0, INJECT_SINGLE_CAP)}\n[截断：原文 ${cleaned.length} 字符，保留前 ${INJECT_SINGLE_CAP}]`;
    truncated = true;
  }
  if (state.injectedChars + body.length > INJECT_SESSION_CAP) return { skipped: true, truncated };
  state.injectedChars += body.length;
  const text = `[非用户输入] 钩子注入（${event}）\n${"─".repeat(8)}\n${body}`;
  return { text, skipped: false, truncated };
}

/** 多钩子注入合并：`#N` 编号 + 空行连接（ZCode 式）。 */
export function mergeInjections(parts: string[]): string {
  return parts.map((p, i) => `#${i + 1} ${p}`).join("\n\n");
}

/** Stop 续跑 reason 专用闸：净化 + 单条帽（无包裹、不计累计——续跑消息不是注入正文，由 loop 落
 * agent/steering-message sourceModule=hooks，与 host/hook 注入分流）。 */
export function capReason(raw: string): string {
  const cleaned = stripAnsiAndControl(raw);
  if (cleaned.length <= INJECT_SINGLE_CAP) return cleaned;
  return `${cleaned.slice(0, INJECT_SINGLE_CAP)}\n[截断：原文 ${cleaned.length} 字符，保留前 ${INJECT_SINGLE_CAP}]`;
}
