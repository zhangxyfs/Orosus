import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { orosusHome } from "@orosus/contracts/home";
import { Access, defineTool, type Tool, type ToolResult } from "@orosus/contracts/tool";
import { FS, type Fs } from "@orosus/contracts/fs";
import { JobRegistry, killTree, decodeOut } from "./jobs.ts";

export { JobRegistry, type BgJob } from "./jobs.ts";

const params = {
  command: z.string().describe("要执行的 shell 命令（Windows=cmd，POSIX=sh）"),
  workdir: z.string().optional().describe("工作目录（相对路径基于上次记忆的目录解析；成功后记为下次缺省——别用 cd，shell 内 cd 不会被记住）"),
  writeOutputTo: z.string().optional().describe("可选：把原始输出经 fs 能力写入此路径"),
  timeoutMs: z.number().int().positive().max(120_000).optional().describe("超时毫秒，默认 120000，超时杀整个进程树"),
  run_in_background: z.boolean().optional().describe("true = 后台执行：立即返回作业 id 与输出文件路径，完成自动通知（勿轮询——进度用 tool-shell__output 读，停运用 tool-shell__kill）"),
};
type BashInput = { command: string; workdir?: string; writeOutputTo?: string; timeoutMs?: number; run_in_background?: boolean };

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

function bashTool(fs: Fs, memory: ShellMemory, registry: JobRegistry): Tool {
  return defineTool({
    name: "tool-shell__bash",
    description: "Execute a shell command. Returns combined stdout/stderr.\nUse ONLY for commands that genuinely need a shell (git, npm, system operations).\nFor file operations, prefer dedicated tools: read/write/edit/glob/grep. This is CRITICAL.\nDefault timeout 120 seconds.\nUse the workdir parameter (not `cd`) to run in a specific directory — it is remembered for the next call.\n`cd` inside a command does NOT carry over (only workdir is remembered).\nFor long-running commands (dev servers, long tests), use run_in_background: returns a job id immediately; completion is reported automatically (no polling needed).",
    parameters: z.object(params),
    resolveExecution: (input) => {
      const { command, workdir, writeOutputTo, timeoutMs, run_in_background } = input as BashInput;
      return Promise.resolve({
        accesses: [Access.subprocess()],
        // 带参规则：审批模块（M3）据此匹配，如配置 "tool-shell__bash(git *)" 放行 git 系命令
        // ——run_in_background 不改变命令本身的危险判定（包装层不改，方案 T3 注记）
        approvalRule: `tool-shell__bash(${command})`,
        // 迷你 glob：仅支持后缀 *（前缀匹配），否则全等。刻意不做完整 glob——审批语义要一眼看懂
        matchesRule: (ruleArgs: string) =>
          ruleArgs.endsWith("*") ? command.startsWith(ruleArgs.slice(0, -1)) : command === ruleArgs,
        execute: (tctx) => {
          if (run_in_background === true) {
            // 后台（M4-3 T3）：spawn 登记即返回——输出落盘、完成自动通知、勿轮询（kimi bashTool.ts:412-436 同款指引）。
            // cwd 同样走解析链，但不改记忆（命令成败未知——T2 规矩 = 退出码 0 才记）。
            // 与 turn 取消脱钩：作业不归 tctx.signal 管（Esc 取消回答不杀后台作业——脱离语义）。
            const { cwd, fellBackTo } = resolveCwd({ command, ...(workdir !== undefined ? { workdir } : {}) }, memory);
            const job = registry.start(command, cwd);
            const note = fellBackTo !== undefined ? `（workdir 目标 ${fellBackTo} 不存在——已回落在 ${cwd} 执行）` : "";
            return Promise.resolve({
              output: `后台作业 ${job.id} 已启动${note}，输出文件 ${job.file}，完成会自动通知，勿轮询。用 tool-shell__output 读取进度。`,
              isError: false,
            });
          }
          return runBash({ command, ...(workdir !== undefined ? { workdir } : {}), ...(writeOutputTo !== undefined ? { writeOutputTo } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, fs, tctx.signal, memory);
        },
      });
    },
  });
}

/** 读后台作业输出（kimi TaskOutput / Reasonix bash_output 同族）。 */
function outputTool(registry: JobRegistry): Tool {
  return defineTool({
    name: "tool-shell__output",
    description: `Read the output of a background shell job (started via tool-shell__bash with run_in_background).
Returns the tail of the job's output file plus its state (running / exited). Default 16000 characters tail; pass chars to adjust.`,
    parameters: z.object({
      id: z.string().describe("后台作业 id（bg-…，tool-shell__bash 后台启动时返回）"),
      chars: z.number().int().positive().max(100_000).optional().describe("读取尾部字符数（默认 16000；字符语义非字节，CJK 不劈半——SW-6）"),
    }),
    resolveExecution: (input) => {
      const { id, chars } = input as { id: string; chars?: number };
      const job = registry.get(id);
      return Promise.resolve({
        // SW-8 放行口径：fs.read 声明 → ask-always 只读放行（decide.ts:108）、ask-risky 常规放行（decide.ts:123）
        accesses: job !== undefined ? [Access.fsRead(job.file)] : [],
        approvalRule: "tool-shell__output",
        execute: () => {
          const want = chars ?? 16_000;
          const r = registry.readTail(id, want);
          if (r === undefined) return Promise.resolve({ output: `无此后台作业："${id}"（本会话未登记——id 形如 bg-xxxxxxxx）`, isError: true });
          const state = r.state === "running" ? "运行中" : `已结束（退出码 ${r.code ?? "null"}）`;
          const header = `[${id} · ${state} · 尾部 ${r.text.length}/${r.totalChars} 字符]`;
          return Promise.resolve({ output: r.text === "" ? `${header}\n（尚无输出）` : `${header}\n${r.text}`, isError: false });
        },
      });
    },
  });
}

/** 停后台作业（kimi TaskStop / Reasonix kill_shell 同族）。 */
function killTool(registry: JobRegistry): Tool {
  return defineTool({
    name: "tool-shell__kill",
    description: "Stop a background shell job by id (kills the whole process tree). Only jobs started by this session can be killed.",
    parameters: z.object({
      id: z.string().describe("要停止的后台作业 id（bg-…）"),
    }),
    resolveExecution: (input) => {
      const { id } = input as { id: string };
      return Promise.resolve({
        // SW-8 放行口径：空 accesses——两档均落常规放行（decide.ts:123；只能杀本会话自己启动的作业，风险自含。
        // 误声明 subprocess 则两档都被询问 decide.ts:119-121——勿加）
        accesses: [],
        approvalRule: "tool-shell__kill",
        execute: () => {
          const ok = registry.kill(id);
          return Promise.resolve(
            ok
              ? { output: `已停止后台作业 ${id}（进程树已杀；完成通知照常送达）`, isError: false }
              : { output: `无此后台作业："${id}"（本会话未登记或已结束清理——id 形如 bg-xxxxxxxx）`, isError: true },
          );
        },
      });
    },
  });
}

/** 后台作业目录（SW-5 落盘命名 bg-<id>.output 保持；目录 = 模块自有——ModuleContext 无 harness spill 通道
 *  （十面之外无目录口，harness 缺省 rules 又含宿主自定义面），按 orosusHome 单点解析；嵌入式自定义
 *  sessionsDir 场景对齐顺延契约窗口（T8 登记）。 */
const defaultBgDir = (): string => join(orosusHome(), "bg");

/** 宿主退出序列的清杀口（cc-haha registerCleanup 同款）：main.ts 退出收口调用——
 *  模块 activate/dispose 维护当前注册表指针；无激活实例 = 空操作。 */
let activeRegistry: JobRegistry | undefined;
export function killAllBackgroundJobs(): void {
  activeRegistry?.killAll();
}

export default defineModule({
  name: "tool-shell",
  version: "0.1.0",
  description: "shell 命令执行工具（bash 前台/后台作业族 output/kill），输出可经 fs 能力落盘",
  api: 1,
  dependsOn: [FS],
  uses: ["subprocess"],
  async activate(ctx) {
    const fs = await ctx.services.get<Fs>(FS);
    const registry = new JobRegistry(defaultBgDir());
    activeRegistry = registry;
    ctx.contribute.tool(bashTool(fs, { lastWorkdir: undefined }, registry)); // 记忆随激活生命周期（reload 重建即清零——新配置新起点）
    ctx.contribute.tool(outputTool(registry));
    ctx.contribute.tool(killTool(registry));
    // 完成通知 = followUp 收集点订阅（loop.ts:213-216：模型无工具调用欲停时 collect，
    // 返回非空即作 steering 注入并 continue——作业完成晚于回合结束也落在下一轮停顿时送达）
    ctx.events.on("agent/follow-up", () => registry.drainNotifications());
    // dispose 杀光活作业（disposeAll 消费链，activate.ts:358——reload 换下时清场）
    return {
      dispose: () => {
        registry.killAll();
        if (activeRegistry === registry) activeRegistry = undefined;
      },
    };
  },
});
