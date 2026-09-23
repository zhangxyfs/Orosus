import { spawn } from "node:child_process";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { Access, defineTool, type Tool, type ToolResult } from "@orosus/contracts/tool";
import { FS, type Fs } from "@orosus/contracts/fs";

const params = {
  command: z.string().describe("要执行的 shell 命令（Windows=cmd，POSIX=sh）"),
  writeOutputTo: z.string().optional().describe("可选：把原始输出经 fs 能力写入此路径"),
  timeoutMs: z.number().int().positive().max(120_000).optional().describe("超时毫秒，默认 120000，超时杀整个进程树"),
};
type BashInput = { command: string; writeOutputTo?: string; timeoutMs?: number };

const MAX_TIMEOUT = 120_000;

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

/** 执行命令：stdout+stderr 合并；退出码非 0 / 超时 / 中止 → 带内 isError（永不 reject）。 */
function runBash(input: BashInput, fs: Fs, signal: AbortSignal): Promise<ToolResult> {
  const timeout = input.timeoutMs ?? MAX_TIMEOUT;
  return new Promise((resolvePromise) => {
    const child = spawn(input.command, { shell: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
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
        if (code === 0) return finish({ output: out, isError: false });
        finish({ output: `[退出码 ${code ?? "null"}]\n${out}`, isError: true });
      })();
    });
  });
}

function bashTool(fs: Fs): Tool {
  return defineTool({
    name: "tool-shell__bash",
    description: "Execute a shell command. Returns combined stdout/stderr.\nUse ONLY for commands that genuinely need a shell (git, npm, system operations).\nFor file operations, prefer dedicated tools: read/write/edit/glob/grep. This is CRITICAL.\nDefault timeout 120 seconds.",
    parameters: z.object(params),
    resolveExecution: (input) => {
      const { command, writeOutputTo, timeoutMs } = input as BashInput;
      return Promise.resolve({
        accesses: [Access.subprocess()],
        // 带参规则：审批模块（M3）据此匹配，如配置 "tool-shell__bash(git *)" 放行 git 系命令
        approvalRule: `tool-shell__bash(${command})`,
        // 迷你 glob：仅支持后缀 *（前缀匹配），否则全等。刻意不做完整 glob——审批语义要一眼看懂
        matchesRule: (ruleArgs: string) =>
          ruleArgs.endsWith("*") ? command.startsWith(ruleArgs.slice(0, -1)) : command === ruleArgs,
        execute: (tctx) => runBash({ command, ...(writeOutputTo !== undefined ? { writeOutputTo } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, fs, tctx.signal),
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
    ctx.contribute.tool(bashTool(fs));
  },
});
