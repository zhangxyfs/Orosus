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
  const json = JSON.stringify(data);
  if (json.length <= DATA_BUDGET) return data;
  return { _truncated: true, preview: json.slice(0, DATA_BUDGET) };
}

export interface DiagSink {
  write(rec: DiagRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** 诊断文件 sink：fire-and-forget 队列 + flush，不阻塞热路径（§11.9）。 */
export function createDiagSink(opts: { dir: string }): DiagSink {
  mkdirSync(opts.dir, { recursive: true });
  // 文件名按写入当日计算（§11.9 diagnostic-<日期>）：跨天运行的长进程自然滚动到新文件
  const fileFor = (): string => join(opts.dir, `diagnostic-${new Date().toISOString().slice(0, 10)}.jsonl`);
  let queue: Promise<void> = Promise.resolve();
  return {
    write(rec) {
      const file = fileFor();
      queue = queue.then(() => void appendFileSync(file, JSON.stringify(rec) + "\n"));
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
