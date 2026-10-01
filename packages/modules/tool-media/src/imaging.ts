// m5-media F10/F12 成像内核（tool-media 自有——模块互不 import 纪律，与 provider-custom/mediapipe-core
// 为有意的双写：口径互指（scaleFor 同式：min(1, 边帽, √(token 预算/像素))）；worker 隔离同 pi 形态。
import { Jimp } from "jimp";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

/** ffmpeg 在场探测（F11/F12 D11 注册制——外部二进制缺席明说解锁条件；进程内 memo 一次）。 */
export let ffmpegProbe: Promise<boolean> | undefined;
export function hasFfmpeg(): Promise<boolean> {
  ffmpegProbe ??= (async () => {
    try {
      const { promisify } = await import("node:util");
      const { execFile } = await import("node:child_process");
      await promisify(execFile)("ffmpeg", ["-version"]);
      return true;
    } catch {
      return false;
    }
  })();
  return ffmpegProbe;
};

/** 魔数嗅探（读文件先认格式——扩展名不可信）。 */
export function sniffMime(buf: Buffer): ImageMime | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

let webpReady: Promise<void> | undefined;
async function ensureWebp(): Promise<void> {
  webpReady ??= (async () => {
    const { readFile: rf } = await import("node:fs/promises");
    const { createRequire: cr } = await import("node:module");
    const { init } = await import("@jsquash/webp/decode.js");
    const decJs = cr(import.meta.url).resolve("@jsquash/webp/decode.js");
    const WA = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Buffer) => unknown } }).WebAssembly;
    init(new WA.Module(await rf(join(dirname(decJs), "codec", "dec", "webp_dec.wasm"))) as never);
  })();
  await webpReady;
}

/** 解码到 Jimp 位图：Jimp 原生格式直读；webp 走 wasm 解码（Jimp 不认 webp——kimi webp-decode 同源）。 */
export async function loadToJimp(buffer: Buffer) {
  if (sniffMime(buffer) === "image/webp") {
    await ensureWebp();
    const { decode } = await import("@jsquash/webp");
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const img = await decode(ab);
    const src = img.data instanceof Uint8ClampedArray ? new Uint8Array(img.data.buffer) : img.data;
    return new Jimp({ data: Buffer.from(src), width: img.width, height: img.height });
  }
  return Jimp.read(buffer);
}

export interface ResizeSpec { maxEdge: number; tokenTier: number }

/** 双口径缩放系数（与 provider-custom mediapipe-core scaleFor 同式双写）。 */
export const scaleFor = (w: number, h: number, spec: ResizeSpec): number =>
  Math.min(1, spec.maxEdge / Math.max(w, h), Math.sqrt((spec.tokenTier * 750) / (w * h)));

export interface ProcessResult { buffer: Buffer; width: number; height: number; mime: "image/png" | "image/jpeg"; unchanged: boolean }

/** 处理内核（worker 内跑）：可选裁剪 → 双口径降采样 → 重编码（webp/gif 出幅 png——Jimp 无该编码器）。 */
export async function processImage(buffer: Buffer, spec: ResizeSpec, region?: { x: number; y: number; width: number; height: number }): Promise<ProcessResult> {
  const base = await loadToJimp(buffer);
  const clampX = Math.max(0, Math.min(Math.floor(region?.x ?? 0), base.width - 1));
  const clampY = Math.max(0, Math.min(Math.floor(region?.y ?? 0), base.height - 1));
  const img = region !== undefined
    ? base.crop({
        x: clampX,
        y: clampY,
        w: Math.max(1, Math.min(Math.floor(region.width), base.width - clampX)),
        h: Math.max(1, Math.min(Math.floor(region.height), base.height - clampY)),
      }) as typeof base
    : base;
  const srcMime = sniffMime(buffer);
  const outMime: "image/png" | "image/jpeg" = srcMime === "image/jpeg" ? "image/jpeg" : "image/png";
  const scale = scaleFor(img.width, img.height, spec);
  if (scale >= 1) {
    const encode = img.getBuffer.bind(img) as (m: string, o?: { quality?: number }) => Promise<Buffer>;
    return { buffer: await encode(outMime, outMime === "image/jpeg" ? { quality: 90 } : {}), width: img.width, height: img.height, mime: outMime, unchanged: true };
  }
  const w = Math.max(2, Math.round(img.width * scale));
  const h = Math.max(2, Math.round(img.height * scale));
  const resized = img.resize({ w: w - (w % 2), h: h - (h % 2) });
  const encode = resized.getBuffer.bind(resized) as (m: string, o?: { quality?: number }) => Promise<Buffer>;
  return { buffer: await encode(outMime, outMime === "image/jpeg" ? { quality: 85 } : {}), width: w - (w % 2), height: h - (h % 2), mime: outMime, unchanged: false };
}

// —— worker 单例（同 provider-custom/mediapipe.ts 形态：execArgv 隔离 + 失败全拒 + inline 回落）——
interface Job { resolve: (r: ProcessResult) => void; reject: (e: Error) => void }
let workerState: { w: Worker; pending: Map<number, Job> } | undefined;
let workerBroken = false;
let jobSeq = 0;

function getWorker() {
  if (workerBroken) return undefined;
  if (workerState !== undefined) return workerState;
  try {
    const w = new Worker(new URL("./imaging-worker.ts", import.meta.url), { execArgv: [] }); // 隔离父进程旗标（vitest --import 等毒化即死）
    const pending = new Map<number, Job>();
    const failAll = (reason: string): void => {
      for (const p of pending.values()) p.reject(new Error(reason));
      pending.clear();
      workerBroken = true;
      workerState = undefined;
    };
    w.on("message", (msg: { id: number; ok: boolean; r?: ProcessResult; error?: string }) => {
      const p = pending.get(msg.id);
      if (p === undefined) return;
      pending.delete(msg.id);
      if (msg.ok && msg.r !== undefined) {
        const b = msg.r.buffer as unknown as Uint8Array;
        p.resolve({ ...msg.r, buffer: Buffer.from(b.buffer, b.byteOffset, b.byteLength) });
      } else p.reject(new Error(msg.error ?? "worker 处理失败"));
    });
    w.on("error", (err) => failAll(`imaging worker 加载失败：${err instanceof Error ? err.message : String(err)}`));
    w.on("exit", (code) => { if (code !== 0) failAll(`imaging worker 异常退出 code=${code}`); });
    workerState = { w, pending };
    // 刻意不 unref：工具执行期（无 fetch 句柄的 --print/管道场景）事件循环可能只剩本 worker——
    // unref 会让进程提前退场、pending 永不结算（node -e TLA 实测饿死）；worker 常驻成本可接受
    return workerState;
  } catch {
    workerBroken = true;
    return undefined;
  }
}

/** 处理执行口：worker 优先、inline 回落（防卡帧优化非正确性依赖）。 */
export async function runProcess(buffer: Buffer, spec: ResizeSpec, region?: { x: number; y: number; width: number; height: number }): Promise<ProcessResult> {
  const wk = getWorker();
  if (wk !== undefined) {
    try {
      return await new Promise<ProcessResult>((resolve, reject) => {
        const id = ++jobSeq;
        wk.pending.set(id, { resolve, reject });
        // 小文件 Buffer 走 node 内存池（共享 AB）——直接 transfer 池 = detached ArrayBuffer 崩；
        // 拷贝出自有 AB 再 transfer（大文件本就自有、此拷贝一次性）
        const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
        wk.w.postMessage({ id, buffer: Buffer.from(ab), spec, ...(region !== undefined ? { region } : {}) }, [ab]);
      });
    } catch { /* inline 兜底 */ }
  }
  return processImage(buffer, spec, region);
}

/** 读文件 + 处理（inline 路径共用）。 */
export async function processFile(path: string, spec: ResizeSpec, region?: { x: number; y: number; width: number; height: number }): Promise<ProcessResult & { srcMime: ImageMime }> {
  const buf = await readFile(path);
  const srcMime = sniffMime(buf);
  if (srcMime === undefined) throw new Error("无法识别的图片格式（支持 png/jpeg/gif/webp）");
  return { ...(await processImage(buf, spec, region)), srcMime };
}
