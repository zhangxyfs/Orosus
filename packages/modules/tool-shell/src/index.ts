import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { Access, defineTool, type Tool, type ToolResult } from "@orosus/contracts/tool";
import { FS, type Fs } from "@orosus/contracts/fs";

const params = {
  command: z.string().describe("要执行的 shell 命令（Windows=cmd，POSIX=sh）"),
  workdir: z.string().optional().describe("工作目录（相对路径基于上次记忆的目录解析；成功后记为下次缺省——别用 cd，shell 内 cd 不会被记住）"),
  writeOutputTo: z.string().optional().describe("可选：把原始输出经 fs 能力写入此路径"),
  timeoutMs: z.number().int().positive().max(120_000).optional().describe("超时毫秒，默认 120000，超时杀整个进程树"),
};
type BashInput = { command: string; workdir?: string; writeOutputTo?: string; timeoutMs?: number };

const MAX_TIMEOUT = 120_000;

/** 跨调用目录记忆（M4-3 T2 伪持久第一半）：记「上次 workdir 参数解析后的绝对路径」——不捕获 shell 内部 cd
 *  （捕获需 shell 感知的 pwd/cd 回写，win32 cmd 与 POSIX 命令不同，SW-9 v1 不做）。 */
interface ShellMemory { lastWorkdir: string | undefined }

/** cwd 解析链：显式 workdir（相对 → 基于上次记忆；无记忆 → 进程 cwd）> 记忆 > 进程 cwd。
 *  目标不存在/不是目录 → 回落进程 cwd 并在结果里说明（cc-haha Shell.ts:222-238 同款兜底，SW-9）。 */
function resolveCwd(input: BashInput, memory: ShellMemory): { cwd: string; fellBackTo: string | undefined } {
  const base = memory.lastWorkdir ?? process.cwd();
  if (input.workdir === undefined) return { cwd: base, fellBackTo: undefined };
  const target = resolve(base, input.workdir);
  try {
    if (statSync(target).isDirectory()) return { cwd: target, fellBackTo: undefined };
  } catch { /* 不存在——落回落 */ }
  return { cwd: process.cwd(), fellBackTo: target };
}

/** 杀整个进程树：Windows 下 shell:true 的孙进程不吃 child.kill（只死 cmd 壳），走 taskkill /T /F；
 *  POSIX 靠 detached 进程组，-pid 一发全灭。 */
const killTree = (child: ReturnType<typeof spawn>): void => {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL"); // 进程组不存在（已退出）时兜底
    }
  }
};

/** 输出解码（2026-09-23 走查批——图3 乱码前案）：Windows 下 shell:true 走 cmd.exe，报错文本是系统
 *  ANSI 代码页（中文系统 GBK/GB18030），utf8 直解整屏 U+FFFD 问号。
 *  三轮修订（走查再现实锤两轮）：①整段二选一在混合流（pnpm UTF-8 + cmd GBK 报错）下必坏一边；
 *  ②U+FFFD 计票不可靠——UTF-8 输出的合法 U+FFFD 与 GBK 解码的伪中文同样带/不带替换符，计票会误杀。
 *  终态 = 按行切分 + fatal UTF-8 严格解码：**字节合法 UTF-8**（合法 U+FFFD 也算合法）原样收，
 *  解码抛错 = 该行不是 UTF-8 → GB18030 兜底。行内编码必然单一（两种编码的多字节序列都不跨 0x0A）。
 *  已知边角：同一行内 UTF-8 与 GBK 字节真混合时整行落 GBK（实测未见，登记）。 */
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const gbk = new TextDecoder("gb18030");
function decodeOut(buf: Buffer): string {
  if (process.platform !== "win32") return buf.toString("utf8");
  return buf
    .toString("latin1") // latin1 = 字节 1:1 透传，只为按行切分
    .split("\n")
    .map((latin) => {
      const line = Buffer.from(latin, "latin1");
      try {
        return utf8Strict.decode(line);
      } catch {
        return gbk.decode(line);
      }
    })
    .join("\n");
}

/** 执行命令：stdout+stderr 合并；退出码非 0 / 超时 / 中止 → 带内 isError（永不 reject）。
 *  退出码 0 = 成功 → 记忆本次实际用过的目录（失败命令不改记忆——T2/SW-9）。 */
function runBash(input: BashInput, fs: Fs, signal: AbortSignal, memory: ShellMemory): Promise<ToolResult> {
  const timeout = input.timeoutMs ?? MAX_TIMEOUT;
  const { cwd, fellBackTo } = resolveCwd(input, memory);
  const cwdNote = fellBackTo !== undefined ? `\n[workdir 目标 ${fellBackTo} 不存在——已回落在 ${cwd} 执行]` : "";
  return new Promise((resolvePromise) => {
    const child = spawn(input.command, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const chunks: Buffer[] = []; // 原始字节累积——close 后统一解码（decodeOut 编码判定需要全量字节）
    let timedOut = false;
    const finish = (r: ToolResult) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise(r);
    };
    const onAbort = () => killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => finish({ output: `spawn 失败：${err.message}`, isError: true }));
    child.on("close", (code) => {
      void (async () => {
        const out = decodeOut(Buffer.concat(chunks));
        if (signal.aborted) return finish({ output: `${out}\n[已中止]`, isError: true });
        if (timedOut) return finish({ output: `${out}\n[超时 ${timeout}ms，已杀进程树]`, isError: true });
        if (input.writeOutputTo !== undefined) {
          try {
            await fs.write(input.writeOutputTo, out);
          } catch (err) {
            return finish({ output: `${out}\n[writeOutputTo 失败：${err instanceof Error ? err.message : String(err)}]`, isError: true });
          }
        }
        if (code === 0) {
          memory.lastWorkdir = cwd; // 记忆 = 本次实际用过的目录（含回落后的 cwd）
          return finish({ output: `${out}${cwdNote}`, isError: false });
        }
        finish({ output: `[退出码 ${code ?? "null"}]\n${out}${cwdNote}`, isError: true });
      })();
    });
  });
}

function bashTool(fs: Fs, memory: ShellMemory): Tool {
  return defineTool({
    name: "tool-shell__bash",
    description: "Execute a shell command. Returns combined stdout/stderr.\nUse ONLY for commands that genuinely need a shell (git, npm, system operations).\nFor file operations, prefer dedicated tools: read/write/edit/glob/grep. This is CRITICAL.\nDefault timeout 120 seconds.\nUse the workdir parameter (not `cd`) to run in a specific directory — it is remembered for the next call.\n`cd` inside a command does NOT carry over (only workdir is remembered).",
    parameters: z.object(params),
    resolveExecution: (input) => {
      const { command, workdir, writeOutputTo, timeoutMs } = input as BashInput;
      return Promise.resolve({
        accesses: [Access.subprocess()],
        // 带参规则：审批模块（M3）据此匹配，如配置 "tool-shell__bash(git *)" 放行 git 系命令
        approvalRule: `tool-shell__bash(${command})`,
        // 迷你 glob：仅支持后缀 *（前缀匹配），否则全等。刻意不做完整 glob——审批语义要一眼看懂
        matchesRule: (ruleArgs: string) =>
          ruleArgs.endsWith("*") ? command.startsWith(ruleArgs.slice(0, -1)) : command === ruleArgs,
        execute: (tctx) => runBash({ command, ...(workdir !== undefined ? { workdir } : {}), ...(writeOutputTo !== undefined ? { writeOutputTo } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, fs, tctx.signal, memory),
      });
    },
  });
}

export default defineModule({
  name: "tool-shell",
  version: "0.1.0",
  description: "shell 命令执行工具（bash），输出可经 fs 能力落盘",
  api: 1,
  dependsOn: [FS],
  uses: ["subprocess"],
  async activate(ctx) {
    const fs = await ctx.services.get<Fs>(FS);
    ctx.contribute.tool(bashTool(fs, { lastWorkdir: undefined })); // 记忆随激活生命周期（reload 重建即清零——新配置新起点）
  },
});
