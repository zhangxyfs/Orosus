import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveShell, type ShellSpec } from "./shell.ts";

/** 杀整个进程树（win32 taskkill /T /F——shell:true 的孙进程不吃 child.kill；POSIX detached 进程组 -pid 一发全灭）。
 *  从 index.ts 平移（作业注册表与前台 bash 共用）。 */
export const killTree = (child: ChildProcess): void => {
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

  /** 收尾清杀（dispose/宿主退出序列共用——cc-haha registerCleanup 同款语义）。 */
  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.done === undefined) killTree(job.child);
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
