import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveShell, type ShellSpec } from "./shell.ts";

/** ---- win32 进程残留清扫（2026-09-30 挂起孤儿诊断批）----
 *  事故形态：agent 跑 pnpm test 挂起 → 杀树只杀掉部分 → vitest 主进程 + worker 池脱树存活，
 *  worker 满核自旋数小时（风扇狂转）。两个实锤漏网缝：taskkill /T 是一次性父子快照，杀树进行时
 *  新生的孙进程逃过（实锤：worker 晚 6 秒出生）；中间父进程先死则链断，孙进程挂死父名下枚举不到
 *  （实锤：vitest 挂在死 pnpm 名下）。清扫 = 按「pid/ppid 落在种子集」匹配补杀——死父的 ppid 是
 *  静态记录不随父消失，孤儿链仍可枚举。POSIX 进程组 kill(-pgid) 语义天然全覆盖，本节全部 no-op。 */

/** win32 进程清单行（Get-CimInstance 两列投影）。 */
export interface ProcRow { pid: number; ppid: number }

/** 解析 powershell 两列 pid/ppid 输出（独立纯函数——测试注入位）。非两列数字行静默丢弃。 */
export function parseProcRows(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
}

/** 活进程快照上沿 ppid 求种子后代闭包（多趟传递——树深有限必收敛；快照时刻成员都活着，链不断）。 */
export function closureFrom(procs: ProcRow[], rootPid: number): Set<number> {
  const seeds = new Set<number>([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!seeds.has(p.pid) && seeds.has(p.ppid)) { seeds.add(p.pid); grew = true; }
    }
  }
  return seeds;
}

/** 清扫候选：活进程 ∧（pid∈seeds ∨ ppid∈seeds）。pid 命中 = 首杀漏刀；ppid 命中 = 快照后新生
 *  或挂在死树成员名下的孤儿。误伤残余：种子 pid 被 PID 复用后新进程育子撞上——清扫窗口 ~1s
 *  且 PID 空间大，实践不可能；best-effort 兜底不做创建时间校验。 */
export function pickVictims(procs: ProcRow[], seeds: Set<number>): ProcRow[] {
  return procs.filter((p) => seeds.has(p.pid) || seeds.has(p.ppid));
}

const SWEEP_DELAY_MS = 400;
const SWEEP_MAX_ROUNDS = 3;
const PS_LIST_TIMEOUT_MS = 5_000;

/** 清扫路径的延迟全部 unref：CLI 常态事件循环有长驻源（输入流/渲染），unref 只在「进程想退而
 *  只剩清扫 pending」时放行——退出序列带走未完成的清扫属预期（退出杀树另有 killAll 快杀口）。 */
const delayUnref = (ms: number): Promise<void> =>
  new Promise((r) => { setTimeout(r, ms).unref(); });

/** 带超时的命令执行（只收 stdout——枚举/杀树两用）。超时 kill 自身单进程兜底，不给清扫挂死 CLI 的机会；
 *  child/stdout 双 unref——fire-and-forget 清扫不拖进程退出与测试收工。 */
const runCapture = (cmd: string, args: string[], timeoutMs: number): Promise<string> =>
  new Promise((resolveP, rejectP) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    c.unref();
    (c.stdout as { unref?: () => void } | null)?.unref?.();
    let out = "";
    const timer = setTimeout(() => { c.kill(); rejectP(new Error(`超时 ${timeoutMs}ms`)); }, timeoutMs);
    c.stdout?.on("data", (d: Buffer) => { out += d.toString("latin1"); }); // 输出仅两列数字，无编码面
    c.on("error", (err) => { clearTimeout(timer); rejectP(err); });
    c.on("close", () => { clearTimeout(timer); resolveP(out); });
  });

/** win32 全量进程两列清单（powershell CIM；wmic 在 Win11 24H2+ 已移除不可依赖）。
 *  任何失败返回空表——清扫是 best-effort，枚举失败不挡主流程。导出作测试探针（④ 深链清杀断言用）。 */
export async function listProcsWin(): Promise<ProcRow[]> {
  try {
    const out = await runCapture(
      "powershell",
      ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"],
      PS_LIST_TIMEOUT_MS,
    );
    return parseProcRows(out);
  } catch {
    return [];
  }
}

/** taskkill /T /F 包 promise（完成/失败都 resolve——杀不死的由后续轮复查兜）。unref 同上。 */
const taskkillTree = (pid: number): Promise<void> =>
  new Promise((resolveP) => {
    const c = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    c.unref();
    c.on("error", () => resolveP());
    c.on("close", () => resolveP());
  });

/** 种子集多轮补杀：每轮延迟后枚举 → 候选空即收手 → 否则逐个 /T 杀并入种子（新生的下轮按 ppid 命中）。
 *  返回补杀进程数。内部永不 reject（fire-and-forget 安全）。 */
async function sweepSeeds(seeds: Set<number>): Promise<number> {
  let killed = 0;
  for (let round = 0; round < SWEEP_MAX_ROUNDS; round++) {
    await delayUnref(SWEEP_DELAY_MS);
    const procs = await listProcsWin();
    if (procs.length === 0) return killed;
    const victims = pickVictims(procs, seeds);
    if (victims.length === 0) return killed;
    await Promise.all(victims.map((v) => taskkillTree(v.pid)));
    killed += victims.length;
    for (const v of victims) seeds.add(v.pid);
  }
  return killed;
}

/** 即扫口（测试断言位 / 需要同步等结果的调用方）：种子 = 树根 pid。活树场景 pid∈seeds 命中根
 *  整树补杀（首杀漏刀兜底）；死根场景直接孤儿（ppid 静态指向死根）理论可枚举。
 *  深链孤儿（挂在死中间父下）枚举约束无解：Git Bash 双层结构（bin\bash → usr\bin/bash → 命令）下
 *  自然 close 的孤儿挂在已死的 usr\bin/bash 名下（2026-09-30 实测取证），无快照时机可记——只有
 *  killTree 的杀前快照能覆盖。挂起/超时重灾场景全走杀路径，此缝接受。 */
export function sweepRootsNow(rootPid: number): Promise<number> {
  if (process.platform !== "win32") return Promise.resolve(0);
  return sweepSeeds(new Set([rootPid]));
}

/** 收工残留清扫（前台 close / 后台 done 生产口）：500ms 窗口内多个树根并作一轮枚举——
 *  高频命令场景不必每条命令都起一次 powershell（全量枚举天然多种子）。fire-and-forget。 */
let pendingRoots: Set<number> | undefined;
let pendingTimer: NodeJS.Timeout | undefined;
export function sweepTreeRemnants(rootPid: number): void {
  if (process.platform !== "win32") return;
  (pendingRoots ??= new Set<number>()).add(rootPid);
  if (pendingTimer === undefined) {
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      const roots = pendingRoots!;
      pendingRoots = undefined;
      void sweepSeeds(roots);
    }, 500);
    pendingTimer.unref();
  }
}

/** 杀整个进程树。POSIX：detached 进程组 -pid 一发全灭（孙进程默认继承进程组，无快照漏杀面）。
 *  win32 完整版（杀前快照 → taskkill /T /F → 杀后清扫）：/T 只杀「执行瞬间」的父子快照，两类
 *  漏网由快照+清扫补——杀树进行时新生的孙进程、中间父先死链断的孙代（杀前快照记全树成员，
 *  死父的 ppid 静态可匹配）。快照会把首杀推迟 ~400ms（powershell 冷启）：交互路径（超时/中止/
 *  kill 工具）无感收尾可接受；退出序列不走这里（killAll 用 taskkillTree 即发快杀）。 */
export const killTree = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  const rootPid = child.pid;
  if (process.platform === "win32") {
    void (async () => {
      const seeds = closureFrom(await listProcsWin(), rootPid); // 枚举失败（空表）= 仅根种子，/T 本身仍杀当前树
      await taskkillTree(rootPid);
      await sweepSeeds(seeds);
    })();
  } else {
    try {
      process.kill(-rootPid, "SIGKILL");
    } catch {
      child.kill("SIGKILL"); // 进程组不存在（已退出）时兜底
    }
  }
};

/** 输出解码（index.ts 平移——后台作业输出落盘与前台回显同一口径）。
 *  Windows 下 cmd 系输出是系统 ANSI 代码页（中文 GBK/GB18030）：字节合法 UTF-8 原样收，解码抛错 → GB18030 兜底。 */
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const gbk = new TextDecoder("gb18030");
export function decodeOut(buf: Buffer): string {
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

/** 后台作业登记项。done 在 close 后置位；notified = followUp 已报过（一次一报）。 */
export interface BgJob {
  id: string;
  child: ChildProcess;
  file: string;
  command: string;
  startedAt: number;
  done?: { code: number | null; chars: number };
  notified: boolean;
}

/** 完成通知话术（kimi「勿轮询」指引配套——作业退出后下一轮停顿时送达）。 */
const notificationText = (job: BgJob): string =>
  `后台作业 ${job.id} 已结束（退出码 ${job.done?.code ?? "null"}，输出 ${job.done?.chars ?? 0} 字符）。用 tool-shell__output 读取。`;

/** MB-14（2026-09-28 code review P3）：陈旧输出文件的判定年龄——超过 7 天的 bg-*.output 启动时清掉。
 *  bg 目录跨会话共享且此前无任何清理路径（作业结束/killAll/dispose 都只杀进程不删文件），单作业输出
 *  可达 GB 级，长期使用无限累积；7 天足够覆盖「隔天回来接着看」的调试窗口。 */
const STALE_OUTPUT_MS = 7 * 24 * 60 * 60 * 1000;

/** 后台作业注册表（M4-3 T3）：spawn 登记 → 输出落盘追加 → close 置 done → followUp 报完成 → 收尾清杀。
 *  SW-5：id = bg-<短随机>，输出文件 <dir>/bg-<id>.output；SW-7：v1 无超时（用户 kill 或进程自终）。 */
export class JobRegistry {
  private jobs = new Map<string, BgJob>();
  readonly dir: string;
  private readonly shell: ShellSpec;
  constructor(dir: string, shell: ShellSpec = resolveShell()) {
    this.dir = dir; // strip-only 不支持 constructor 参数属性语法（在案坑）——显式声明+赋值
    this.shell = shell; // 前台/后台共用同一壳结论（走查批 2026-09-26——后台 bash 作业与前台同方言）
  }

  /** 启动作业：立即返回登记项（不等命令完成——输出经文件描述符直接落盘，内存零累积）。 */
  start(command: string, cwd?: string): BgJob {
    mkdirSync(this.dir, { recursive: true });
    const id = `bg-${randomUUID().slice(0, 8)}`;
    const file = join(this.dir, `${id}.output`);
    const fd = openSync(file, "a");
    const child =
      this.shell.kind === "bash"
        ? spawn(this.shell.bashPath, ["-c", command], {
            ...(cwd !== undefined ? { cwd } : {}),
            stdio: ["ignore", "pipe", "pipe"],
            detached: false, // win32 专用分支——taskkill /T 管整树
          })
        : spawn(command, {
            shell: true,
            ...(cwd !== undefined ? { cwd } : {}),
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
          });
    const job: BgJob = { id, child, file, command, startedAt: Date.now(), notified: false };
    child.stdout.on("data", (d: Buffer) => writeSync(fd, d));
    child.stderr.on("data", (d: Buffer) => writeSync(fd, d));
    child.on("error", (err) => writeSync(fd, `\n[spawn 失败：${err.message}]`));
    child.on("close", (code) => {
      closeSync(fd);
      // 字符数在 close 时一次算（增量按字节计数会劈多字节；decodeOut 与前台同口径）
      let chars = 0;
      try { chars = decodeOut(readFileSync(file)).length; } catch { /* 文件被外部抹除按 0 */ }
      job.done = { code, chars };
      if (child.pid !== undefined) sweepTreeRemnants(child.pid); // 后台 done 同款残留清扫（`cmd &` 形态——bash 退、孙进程活）
    });
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): BgJob | undefined {
    return this.jobs.get(id);
  }

  /** 读作业输出尾部（chars = 字符语义非字节，CJK 不劈半——SW-6 缺省 16000）。
   *  只读尾部字节窗（UTF-8 单字符 ≤4 字节上界估），大输出文件不全读；首行残线丢弃。
   *  totalChars 口径按 state 分（MB-13 2026-09-28 code review P3）：done = 精确字符数（close 时一次算）；
   *  running = 输出文件当前字节数（总量未知时的诚实近似——旧实现拿已读窗口字符数冒充分母，
   *  把「窗口只能装这么多」报成「全部就这么多」）；调用方按 state 区分展示口径。 */
  readTail(id: string, chars: number): { text: string; totalChars: number; state: "running" | "done"; code: number | null } | undefined {
    const job = this.jobs.get(id);
    if (job === undefined || !existsSync(job.file)) return undefined;
    const size = statSync(job.file).size;
    const fd = openSync(job.file, "r");
    let buf: Buffer;
    const offset = Math.max(0, size - chars * 4);
    try {
      buf = Buffer.alloc(size - offset);
      let n = 0;
      while (n < buf.length) n += readSync(fd, buf, n, buf.length - n, offset + n);
      if (n < buf.length) buf = buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
    // 窗口起点可能劈在 UTF-8 多字节字符中间（T3 ④ 实锤：900 字节 CJK 文取尾 200 字节起点非字符界——
    // 不修剪则 utf8Strict 整行判死落 GBK 成乱码）：跳过至多 3 个续字节（10xxxxxx）对齐字符界
    if (offset > 0) {
      let trim = 0;
      while (trim < 3 && trim < buf.length && (buf[trim]! & 0xc0) === 0x80) trim++;
      if (trim > 0) buf = buf.subarray(trim);
    }
    let decoded = decodeOut(buf);
    if (size > chars * 4) {
      const nl = decoded.indexOf("\n");
      if (nl >= 0) decoded = decoded.slice(nl + 1); // 窗口截断的残首行丢弃
    }
    const totalChars = job.done?.chars ?? size; // MB-13：运行中用文件字节数近似总量（done 后是精确字符数）
    return {
      text: decoded.slice(-chars),
      totalChars,
      state: job.done !== undefined ? "done" : "running",
      code: job.done?.code ?? null,
    };
  }

  /** 停作业（复用 killTree——只能杀本会话登记的作业，SW-8 风险自含）。
   *  MB-12（2026-09-28 code review P3）：三态如实——未知 id / 已自然结束（什么也没杀）/ 已杀进程树；
   *  调用方据此措辞，不再对已结束作业谎报「进程树已杀」。 */
  kill(id: string): { state: "unknown" } | { state: "already-done"; code: number | null } | { state: "killed" } {
    const job = this.jobs.get(id);
    if (job === undefined) return { state: "unknown" };
    if (job.done !== undefined) return { state: "already-done", code: job.done.code };
    killTree(job.child);
    return { state: "killed" };
  }

  /** followUp 收集口：done 且未报的作业置已报并出货（一次一报；kimi 完成通知同款——
   *  作业完成晚于回合结束也没关系，通知落在下一轮停顿时送达）。 */
  drainNotifications(): { text: string; sourceModule: string }[] {
    const out: { text: string; sourceModule: string }[] = [];
    for (const job of this.jobs.values()) {
      if (job.done !== undefined && !job.notified) {
        job.notified = true;
        out.push({ text: notificationText(job), sourceModule: "tool-shell" });
      }
    }
    return out;
  }

  /** 收尾清杀（dispose/宿主退出序列共用——cc-haha registerCleanup 同款语义）。
   *  win32 走 taskkillTree 即发快杀而非完整 killTree：完整版的杀前快照会把首杀推迟 ~400ms，
   *  退出序列不等（process.exit 会带走未发的杀）——即发即走，树根活着时 /T 本身可靠；
   *  POSIX killTree（进程组）本就是即发即杀。 */
  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.done === undefined) {
        if (process.platform === "win32" && job.child.pid !== undefined) void taskkillTree(job.child.pid);
        else killTree(job.child);
      }
    }
  }

  /** MB-14（2026-09-28 code review P3）：启动时清理陈旧输出文件——只认本目录 bg-<8 位 hex>.output 命名、
   *  mtime 超过 maxAge 的删（best-effort：目录不存在/单文件失败都静默——清理失败不该挡启动）。
   *  本会话新写的文件 mtime 即当前，天然不受影响；非 bg 命名的文件一概不碰。 */
  cleanupStaleOutputs(maxAgeMs: number = STALE_OUTPUT_MS): void {
    try {
      const cutoff = Date.now() - maxAgeMs;
      for (const e of readdirSync(this.dir, { withFileTypes: true })) {
        if (!e.isFile() || !/^bg-[0-9a-f]{8}\.output$/.test(e.name)) continue;
        const f = join(this.dir, e.name);
        try {
          if (statSync(f).mtimeMs < cutoff) rmSync(f);
        } catch { /* 单文件失败不停批 */ }
      }
    } catch { /* 目录不存在/不可读——本就无事可清 */ }
  }

  /** 测试探针。 */
  get size(): number {
    return this.jobs.size;
  }
}
