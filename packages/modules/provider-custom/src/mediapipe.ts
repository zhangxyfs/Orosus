// m5-media F5 发送副本管理（主线程编排面）：磁盘是事实源——**原件永不改写**，超尺寸图在首次发送时
// 生成降采样「发送副本」（<原名>.send-<maxEdge>-<tier>.<ext>，落原件同目录随会话桶清理），此后发送
// 全走副本（一次成本）。worker 线程跑压缩（pi 形态——Jimp 解大图是 CPU 活，主线程卡 TUI 帧）；
// worker 不可用（受限环境）inline 回落，功能不丢。尺寸嗅探（PNG IHDR/JPEG SOF/GIF/WEBP VP8X 头部直读）
// 是零解码快路径——多数请求（图已达标）连 worker 都不进。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ContentPart, ModelMessage } from "@orosus/contracts/provider";
import {
  DEFAULT_MAX_EDGE, DEFAULT_TOKEN_TIER, resizeFile, scaleFor, type ResizeSpec,
} from "./mediapipe-core.ts";

type ImagePart = Extract<ContentPart, { kind: "image" }>;

// —— 尺寸嗅探（头部直读，零解码）——
export function sniffImageDims(buf: Buffer): { w: number; h: number } | undefined {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; // PNG IHDR
  }
  if (buf.length >= 10 && buf.subarray(0, 3).toString("ascii") === "GIF") {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    const fourcc = buf.subarray(12, 16).toString("ascii");
    if (fourcc === "VP8X") {
      const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { w, h };
    }
    if (fourcc === "VP8 " && buf.length > 30) {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === "VP8L" && buf.length > 25) {
      const b = buf.readUInt32LE(21);
      const w = (b & 0x3fff) + 1;
      const h = ((b >> 14) & 0x3fff) + 1;
      return { w, h };
    }
    return undefined;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG：扫描段找 SOF0/2（C0/C2）
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1]!;
      if (marker === 0xc0 || marker === 0xc2) return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
      off += 2 + buf.readUInt16BE(off + 2);
    }
    return undefined;
  }
  return undefined;
}

// —— worker 单例（串行队列——压缩本就要限流，队列天然背压）——
let worker: { w: Worker; pending: Map<number, { resolve: (v: { buffer: Buffer; width: number; height: number; mime: string; unchanged?: boolean }) => void; reject: (e: Error) => void }> } | undefined;
let workerBroken = false;
let seq = 0;

function getWorker() {
  if (workerBroken) return undefined;
  if (worker !== undefined) return worker;
  try {
    // execArgv: []——worker 不继承父进程旗标：vitest 的 --import / node --input-type=module -e 等
    // 旗标会被 worker 当启动参数毒化（实测「--input-type can only be used with string input」即死）。
    // Node 24 原生 type-strip .ts，worker 无需任何旗标即可加载本件。
    const w = new Worker(new URL("./media-worker.ts", import.meta.url), { execArgv: [] });
    const pending = new Map<number, { resolve: (v: { buffer: Buffer; width: number; height: number; mime: string; unchanged?: boolean }) => void; reject: (e: Error) => void }>();
    const failAll = (reason: string): void => {
      for (const p of pending.values()) p.reject(new Error(reason));
      pending.clear();
      workerBroken = true;
      worker = undefined;
    };
    w.on("message", (msg: { id: number; ok: boolean; buffer?: Uint8Array; width?: number; height?: number; mime?: string; unchanged?: boolean; error?: string }) => {
      const p = pending.get(msg.id);
      if (p === undefined) return;
      pending.delete(msg.id);
      if (msg.ok) {
        const b = msg.buffer!;
        p.resolve({ buffer: Buffer.from(b.buffer, b.byteOffset, b.byteLength), width: msg.width!, height: msg.height!, mime: msg.mime!, ...(msg.unchanged === true ? { unchanged: true } : {}) });
      }
      else p.reject(new Error(msg.error ?? "worker 压缩失败"));
    });
    // 加载炸/意外退场：pending 全拒绝（不结算 = 调用方永久悬挂）+ 后续全 inline
    w.on("error", (err) => failAll(`worker 加载失败：${err instanceof Error ? err.message : String(err)}`));
    w.on("exit", (code) => { if (code !== 0) failAll(`worker 异常退出 code=${code}`); });
    worker = { w, pending };
    w.unref?.(); // 不阻塞进程退出（vitest/CLI 收尾不被 worker 拖住）
    return worker;
  } catch {
    workerBroken = true;
    return undefined;
  }
}

/** 压缩执行口：worker 优先（防卡帧）、inline 回落（功能等价——worker 是优化不是正确性依赖）。
 *  注意 worker 路径 transferList 转移 buf 底衬（主线程侧 buf 失效——调用方需在此前用完）。 */
async function runResize(path: string, buf: Buffer, spec: ResizeSpec): Promise<{ buffer: Buffer; width: number; height: number; mime: string; unchanged?: boolean }> {
  const wk = getWorker();
  if (wk !== undefined) {
    try {
      return await new Promise<{ buffer: Buffer; width: number; height: number; mime: string; unchanged?: boolean }>((resolve, reject) => {
        const id = ++seq;
        wk.pending.set(id, { resolve, reject });
        // 小文件 Buffer 走 node 内存池（共享 AB）——transfer 池 = detached 崩；拷贝出自有 AB 再 transfer
        const ab2 = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        wk.w.postMessage({ id, buffer: Buffer.from(ab2), maxEdge: spec.maxEdge, tokenTier: spec.tokenTier }, [ab2]);
      });
    } catch {
      // worker 失败——inline 兜底（下方重读文件）
    }
  }
  return resizeFile(path, spec);
}

// —— 发送副本管理 ——

const EXT_OF: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "png", "image/webp": "png" };

export interface SendCopyResult {
  /** 发送应读的路径（副本或原件）。 */
  path: string;
  /** true = 生成了降采样副本（原件不动）。 */
  resized: boolean;
  width: number;
  height: number;
  mime: string;
}

/**
 * 确保发送副本：先嗅尺寸（零解码）——达标直返原件；超尺寸查副本缓存（命中即返，一次成本）；
 * 未命中跑压缩（worker）落盘副本。任何失败（读不了/嗅不出/压失败/写失败）诚实回落原件——
 * 后续 F6 格式策略/F7 预算层还有帽值防线，这里宁可放行不炸发送。
 */
export async function ensureSendCopy(path: string, spec: ResizeSpec = { maxEdge: DEFAULT_MAX_EDGE, tokenTier: DEFAULT_TOKEN_TIER }): Promise<SendCopyResult> {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return { path, resized: false, width: 0, height: 0, mime: "" }; // 读不到——translate 层自有缺失降级
  }
  const dims = sniffImageDims(buf);
  if (dims === undefined) return { path, resized: false, width: 0, height: 0, mime: "" };
  if (scaleFor(dims.w, dims.h, spec) >= 1) return { path, resized: false, width: dims.w, height: dims.h, mime: "" };
  const stem = basename(path).replace(/\.[^.]+$/, "");
  const ext = extname(path);
  const srcMime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/png";
  const outExt = EXT_OF[srcMime] ?? "png";
  const copyPath = join(dirname(path), `${stem}.send-${spec.maxEdge}-${spec.tokenTier}.${outExt}`);
  if (existsSync(copyPath)) {
    return { path: copyPath, resized: true, width: dims.w, height: dims.h, mime: srcMime };
  }
  try {
    const result = await runResize(path, buf, spec);
    if (result.unchanged === true) return { path, resized: false, width: result.width, height: result.height, mime: result.mime };
    writeFileSync(copyPath, result.buffer, { mode: 0o600 });
    return { path: copyPath, resized: true, width: result.width, height: result.height, mime: result.mime };
  } catch {
    return { path, resized: false, width: dims.w, height: dims.h, mime: srcMime }; // 压缩失败回落原件
  }
}

// —— 请求组装期编排（streams 调用口）——

/**
 * 发送副本编排（m5-media F5——translate 前一步）：扫全部 image part（user 消息 + toolResult.parts），
 * 超尺寸者换发送副本路径。达标图零拷贝零开销（messages 原引用直返）。worker 不可用 inline 回落。
 */
/** 副本出幅 mime：webp/gif 无法重编码原格式（Jimp 无该编码器）——统一转 png；png/jpeg 保原格式。 */
const outMimeOf = (m: string): "image/png" | "image/jpeg" => (m === "image/jpeg" ? "image/jpeg" : "image/png");

export async function prepareImagesForWire(messages: ModelMessage[], spec: ResizeSpec = { maxEdge: DEFAULT_MAX_EDGE, tokenTier: DEFAULT_TOKEN_TIER }): Promise<ModelMessage[]> {
  const jobs: Promise<void>[] = [];
  const swaps = new Map<string, string>(); // 原 path → 副本 path
  const partsOf = (m: ModelMessage): ImagePart[] =>
    m.role === "toolResult" ? (m.parts ?? []).filter((p): p is ImagePart => p.kind === "image") : m.content.filter((p): p is ImagePart => p.kind === "image");
  for (const m of messages) {
    for (const p of partsOf(m)) {
      if (swaps.has(p.path)) continue;
      jobs.push(ensureSendCopy(p.path, spec).then((r) => { if (r.resized && r.path !== p.path) swaps.set(p.path, r.path); }));
    }
  }
  if (swaps.size === 0 && jobs.length === 0) return messages; // 无图零开销
  await Promise.all(jobs);
  if (swaps.size === 0) return messages; // 全达标——原引用直返
  const swap = (path: string): string => swaps.get(path) ?? path;
  return messages.map((m): ModelMessage => {
    if (m.role === "toolResult") {
      if (m.parts === undefined || !m.parts.some((p) => p.kind === "image" && swaps.has(p.path))) return m;
      return { ...m, parts: m.parts.map((p) => (p.kind === "image" && swaps.has(p.path) ? { ...p, path: swap(p.path), mimeType: outMimeOf(p.mimeType) } : p)) };
    }
    if (!m.content.some((p) => p.kind === "image" && swaps.has(p.path))) return m;
    return { ...m, content: m.content.map((p) => (p.kind === "image" && swaps.has(p.path) ? { ...p, path: swap(p.path), mimeType: outMimeOf(p.mimeType) } : p)) };
  });
}
