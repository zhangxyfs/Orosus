import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@orosus/contracts/module";

/** 诊断记录（§11.9）：旁路管线，不是事实源，可滚动清理。 */
export interface DiagRecord {
  v: 1;
  ts: string;
  lvl: "trace" | "debug" | "info" | "warn" | "error";
  code: string;
  module: string;
  sess?: string;
  turn?: string;
  call?: string;
  gen?: number;
  msg: string;
  data?: Record<string, unknown>;
}

export interface DiagCtx {
  sess?: string;
  turn?: string;
  call?: string;
  gen?: number;
}

const DATA_BUDGET = 2048;

function capData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    // CH-11 修复：循环引用/BigInt 等不可序列化 data——日志路径纪律「永不抛」：降级标记 + 安全预览
    //（String() 也可能被自定义 toString 抛——双层兜底到 Object 原生标签，永不越界）
    let preview: string;
    try { preview = String(data); } catch { preview = Object.prototype.toString.call(data); }
    return { _unserializable: true, preview: preview.slice(0, DATA_BUDGET) };
  }
  if (json.length <= DATA_BUDGET) return data;
  return { _truncated: true, preview: json.slice(0, DATA_BUDGET) };
}

export interface DiagSink {
  write(rec: DiagRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** 诊断文件 sink：微任务排队 + flush（§11.9）。CH-13：写盘本身是同步 appendFileSync——只推迟到
 *  微任务、仍阻塞事件循环（每条一次 open/write/close）；诊断量级小接受该形态，注释不宣称「不阻塞热路径」。 */
export function createDiagSink(opts: { dir: string }): DiagSink {
  mkdirSync(opts.dir, { recursive: true });
  // 文件名按写入当日计算（§11.9 diagnostic-<日期>）：跨天运行的长进程自然滚动到新文件
  const fileFor = (): string => join(opts.dir, `diagnostic-${new Date().toISOString().slice(0, 10)}.jsonl`);
  let queue: Promise<void> = Promise.resolve();
  return {
    write(rec) {
      const file = fileFor();
      // CH-11 连带：绕过 capData 直写 sink 的坏 data（BigInt/循环引用）——同款降级兜底，
      // 整记录保住、data 换标记（该降级记录自身恒可序列化，二次 stringify 不会抛）
      let line: string;
      try {
        line = JSON.stringify(rec);
      } catch {
        line = JSON.stringify({ ...rec, data: { _unserializable: true } });
      }
      // CH-04 修复（2026-09-28 code review P1）：一次写盘失败（盘满/文件被锁/文件名撞目录）不得毒化整条
      // 队列——旧实现 rejected 链使后续 write 回调全跳过（静默丢日志）、尾部无人接的 rejection 崩进程、
      // flush/close 永拒（harness close 中断）。单条失败就地吞（诊断是旁路不是事实源，降级可用），链继续。
      queue = queue
        .then(() => void appendFileSync(file, line + "\n"))
        .catch(() => undefined);
    },
    async flush() {
      await queue;
    },
    async close() {
      await queue;
    },
  };
}

/** 以模块名命名的 logger 工厂（ctx.log 的实现，§5.1）。关联字段经第三参数透传。 */
export function createLogger(sink: DiagSink, module: string): Logger & {
  withCtx(ctx: DiagCtx): Logger;
} {
  const make = (ctx: DiagCtx): Logger => {
    const write = (lvl: DiagRecord["lvl"]) => (code: string, msg: string, data?: Record<string, unknown>) => {
      const rec: DiagRecord = { v: 1, ts: new Date().toISOString(), lvl, code, module, msg };
      const capped = capData(data);
      if (capped !== undefined) rec.data = capped;
      if (ctx.sess !== undefined) rec.sess = ctx.sess;
      if (ctx.turn !== undefined) rec.turn = ctx.turn;
      if (ctx.call !== undefined) rec.call = ctx.call;
      if (ctx.gen !== undefined) rec.gen = ctx.gen;
      sink.write(rec);
    };
    return { trace: write("trace"), debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
  };
  const base = make({});
  return Object.assign(base, { withCtx: (ctx: DiagCtx) => make(ctx) });
}
