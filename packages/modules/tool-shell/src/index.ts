import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { orosusHome } from "@orosus/contracts/home";
import { Access, defineTool, type Tool, type ToolResult } from "@orosus/contracts/tool";
import { FS, type Fs } from "@orosus/contracts/fs";
import { JobRegistry, killTree, decodeOut, sweepTreeRemnants, type BgJob } from "./jobs.ts";
import { resolveShell, lintCmdCommand, classifyFailure, type ShellSpec } from "./shell.ts";

export { JobRegistry, type BgJob } from "./jobs.ts";

type BashInput = { command: string; workdir?: string; writeOutputTo?: string; timeoutMs?: number; run_in_background?: boolean };

const MAX_TIMEOUT = 120_000;
/** 前台输出捕获上限（MB-01）：头/尾各 256KB——中段丢弃。足够覆盖溢写截断口径（32KB）两个数量级，
 *  同时把失控命令的内存占用钉死在 ~512KB。 */
const CAPTURE_HEAD = 256 * 1024;
const CAPTURE_TAIL = 256 * 1024;

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
 *  退出码 0 = 成功 → 记忆本次实际用过的目录（失败命令不改记忆——T2/SW-9）。
 *  壳由 resolveShell 决定（走查批 2026-09-26）：bash = 显式 argv（bin\bash.exe 自带 /usr/bin 前置，
 *  POSIX 命令直通）；cmd/sh = shell:true 现状。 */
function runBash(input: BashInput, fs: Fs, signal: AbortSignal, memory: ShellMemory, shell: ShellSpec): Promise<ToolResult> {
  const timeout = input.timeoutMs ?? MAX_TIMEOUT;
  const { cwd, fellBackTo } = resolveCwd(input, memory);
  const cwdNote = fellBackTo !== undefined ? `\n[workdir 目标 ${fellBackTo} 不存在——已回落在 ${cwd} 执行]` : "";
  return new Promise((resolvePromise) => {
    const child =
      shell.kind === "bash"
        ? spawn(shell.bashPath, ["-c", input.command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: false }) // win32 专用分支——taskkill /T 管整树
        : spawn(input.command, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    // MB-01 修复（2026-09-28 code review P1）：前台捕获上限——失控命令（yes 死循环等）无界累积可 OOM 整个
    // CLI。头 256KB 原样 + 尾 256KB 滚动保留、中段丢弃并如实标注；上限内零改动（字节序完全一致）。
    const headBufs: Buffer[] = [];
    let headUsed = 0;
    const tailBufs: Buffer[] = [];
    let tailUsed = 0;
    let droppedBytes = 0;
    const onChunk = (d: Buffer): void => {
      if (droppedBytes === 0 && headUsed + d.length <= CAPTURE_HEAD) { headBufs.push(d); headUsed += d.length; return; }
      tailBufs.push(d);
      tailUsed += d.length;
      while (tailUsed > CAPTURE_TAIL) { // 滚动：丢最老的超额字节（= 中段）
        const first = tailBufs[0]!;
        const over = tailUsed - CAPTURE_TAIL;
        if (first.length <= over) { tailBufs.shift(); tailUsed -= first.length; droppedBytes += first.length; }
        else { tailBufs[0] = first.subarray(over); droppedBytes += over; tailUsed -= over; }
      }
    };
    const captureOut = (): string =>
      droppedBytes > 0
        ? `${decodeOut(Buffer.concat(headBufs))}\n[…中段截断 ${droppedBytes} 字节——前台捕获上限：头尾各 ${CAPTURE_HEAD / 1024}KB…]\n${decodeOut(Buffer.concat(tailBufs))}`
        : decodeOut(Buffer.concat([...headBufs, ...tailBufs]));
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
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => finish({ output: `spawn 失败：${err.message}`, isError: true }));
    child.on("close", (code) => {
      void (async () => {
        // 收工残留清扫（2026-09-30 挂起孤儿诊断批）：正常完成的树也可能留下后台孙进程（`cmd &`
        // 形态——bash 退、孙进程活）。fire-and-forget（500ms 合并窗口），不拖 finish。
        if (child.pid !== undefined) sweepTreeRemnants(child.pid);
        const out = captureOut();
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
        // 失败双注记：分类线（cmd 壳「命令不存在」就地翻译——护栏漏网时的第二道线）
        // + 产出标注（有输出却非零退出——模型要的数据多半已在，别盲目重试）
        const missNote = shell.kind === "cmd" ? classifyFailure(out) : undefined;
        const prodNote = out.trim() !== "" ? "\n[注意：退出码非 0 但上方已有产出——先读输出再决定是否重试]" : "";
        finish({ output: `[退出码 ${code ?? "null"}]\n${out}${missNote !== undefined ? `\n${missNote}` : ""}${prodNote}${cwdNote}`, isError: true });
      })();
    });
  });
}

/** 工具文案随壳方言走（模型对工具描述的遵守度远高于泛泛系统提醒——「告诉过」≠「会照做」）。 */
function dialectTexts(shell: ShellSpec): { description: string; commandHint: string } {
  const base =
    shell.kind === "bash"
      ? "Execute a shell command via Git Bash (`bash -c`). POSIX syntax works: head/tail/grep/sed/awk/ls/cat are available.\nReturns combined stdout/stderr."
      : shell.kind === "cmd"
        ? "Execute a shell command. Returns combined stdout/stderr.\nThe shell on Windows is cmd.exe: chain commands with `&&` (NOT `;`). POSIX commands DO NOT exist in cmd (head/tail/grep/sed/awk/ls/cat/wc/less) — use cmd equivalents (grep→findstr /I, ls→dir) or PowerShell (`... | Select-Object -First N` for truncation). Do NOT swallow stderr with 2>nul."
        : "Execute a shell command via POSIX sh. Returns combined stdout/stderr.";
  const commandHint =
    shell.kind === "bash"
      ? "要执行的 shell 命令（本机经 Git Bash 执行——POSIX 语法可用）"
      : shell.kind === "cmd"
        ? "要执行的 shell 命令（Windows=cmd：无 head/grep 等 POSIX 命令；POSIX=sh）"
        : "要执行的 shell 命令（POSIX sh）";
  return {
    description: `${base}\nUse ONLY for commands that genuinely need a shell (git, npm, system operations).\nFor file operations, prefer dedicated tools: read/write/edit/glob/grep. This is CRITICAL.\nDefault timeout 120 seconds.\nUse the workdir parameter (not \`cd\`) to run in a specific directory — it is remembered for the next call.\n\`cd\` inside a command does NOT carry over (only workdir is remembered).\nFor long-running commands (dev servers, long tests), use run_in_background: returns a job id immediately; completion is reported automatically (no polling needed).`,
    commandHint,
  };
}

function bashTool(fs: Fs, memory: ShellMemory, registry: JobRegistry, shell: ShellSpec): Tool {
  const { description, commandHint } = dialectTexts(shell);
  return defineTool({
    name: "tool-shell__bash",
    description,
    parameters: z.object({
      command: z.string().describe(commandHint),
      workdir: z.string().optional().describe("工作目录（相对路径基于上次记忆的目录解析；成功后记为下次缺省——别用 cd，shell 内 cd 不会被记住）"),
      writeOutputTo: z.string().optional().describe("可选：把原始输出经 fs 能力写入此路径"),
      timeoutMs: z.number().int().positive().max(120_000).optional().describe("超时毫秒，默认 120000，超时杀整个进程树"),
      run_in_background: z.boolean().optional().describe("true = 后台执行：立即返回作业 id 与输出文件路径，完成自动通知（勿轮询——进度用 tool-shell__output 读，停运用 tool-shell__kill）"),
    }),
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
          // cmd 方言护栏（走查批 2026-09-26）：POSIX 命令在 cmd 必炸——执行前拦截并教学，
          // 前台/后台同拦（后台只是执行形态，方言问题相同）。bash/sh 壳不拦。
          const guard = shell.kind === "cmd" ? lintCmdCommand(command) : undefined;
          if (guard !== undefined) return Promise.resolve({ output: guard, isError: true });
          if (run_in_background === true) {
            // 后台（M4-3 T3）：spawn 登记即返回——输出落盘、完成自动通知、勿轮询（kimi bashTool.ts:412-436 同款指引）。
            // cwd 同样走解析链，但不改记忆（命令成败未知——T2 规矩 = 退出码 0 才记）。
            // 与 turn 取消脱钩：作业不归 tctx.signal 管（Esc 取消回答不杀后台作业——脱离语义）。
            const { cwd, fellBackTo } = resolveCwd({ command, ...(workdir !== undefined ? { workdir } : {}) }, memory);
            // MB-05（2026-09-28 code review P3）：registry.start 的 mkdirSync/openSync 是同步抛错点（目录不可写/
            // ENOSPC/EMFILE/权限）——不带内会把同步异常抛出 execute，违反「错误带内返回」契约、只能靠核侧
            // catch-all 兜底且报错无恢复指引；这里自己接住带内返回。
            let job: BgJob;
            try {
              job = registry.start(command, cwd);
            } catch (err) {
              return Promise.resolve({
                output: `后台作业启动失败：${err instanceof Error ? err.message : String(err)}——检查输出目录 ${registry.dir} 可写（磁盘空间/权限）后重试，或去掉 run_in_background 改前台执行`,
                isError: true,
              });
            }
            const note = fellBackTo !== undefined ? `（workdir 目标 ${fellBackTo} 不存在——已回落在 ${cwd} 执行）` : "";
            return Promise.resolve({
              output: `后台作业 ${job.id} 已启动${note}，输出文件 ${job.file}，完成会自动通知，勿轮询。用 tool-shell__output 读取进度。`,
              isError: false,
            });
          }
          return runBash({ command, ...(workdir !== undefined ? { workdir } : {}), ...(writeOutputTo !== undefined ? { writeOutputTo } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, fs, tctx.signal, memory, shell);
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
          // MB-13（2026-09-28 code review P3）：运行中 totalChars = 文件字节数近似（非精确字符数）——状态头如实
          // 标「约 N 字节」，不再用「尾部 X/Y 字符」把窗口值冒充总量；已结束才用精确字符分母
          const header = r.state === "running"
            ? `[${id} · ${state} · 尾部 ${r.text.length} 字符 / 输出已积累约 ${r.totalChars} 字节]`
            : `[${id} · ${state} · 尾部 ${r.text.length}/${r.totalChars} 字符]`;
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
    description: "Stop a background shell job by id (kills the whole process tree). Only jobs started by this session can be killed.\nIf the job already finished on its own, the result says so — nothing is killed.",
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
          // MB-12（2026-09-28 code review P3）：三态如实——已自然结束的作业报「已自行结束」，
          // 不再谎报「进程树已杀」（模型会误以为是自己终止的）
          const r = registry.kill(id);
          if (r.state === "killed") {
            return Promise.resolve({ output: `已停止后台作业 ${id}（进程树已杀；完成通知照常送达）`, isError: false });
          }
          if (r.state === "already-done") {
            return Promise.resolve({ output: `后台作业 ${id} 已自行结束（退出码 ${r.code ?? "null"}），无需停止——如需输出用 tool-shell__output 读取`, isError: false });
          }
          return Promise.resolve({ output: `无此后台作业："${id}"（本会话未登记——id 形如 bg-xxxxxxxx）`, isError: true });
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
    const shell = resolveShell(); // 激活期一次解析（reload 重建即重探）；前台/后台/文案共用同一结论
    const registry = new JobRegistry(defaultBgDir(), shell);
    registry.cleanupStaleOutputs(); // MB-14：启动清陈旧（>7 天的 bg-*.output）——bg 目录不再跨会话无限累积
    activeRegistry = registry;
    ctx.contribute.tool(bashTool(fs, { lastWorkdir: undefined }, registry, shell)); // 记忆随激活生命周期（reload 重建即清零——新配置新起点）
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
