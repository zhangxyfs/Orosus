// m5-media F5 压缩管线内核（纯函数面——worker 与主线程共用；Jimp 纯 JS 零原生 + @jsquash/webp wasm 解码）。
// 学名对照：fitWithinEdge 学 kimi image-compress.ts、token 分档反解学 qwen omni/smart-resize.ts
//（IMAGE_TOKEN_BUDGET_TIERS 256/1024/2048）、webp 解码学 kimi webp-decode（Jimp 不认 webp——解码后转 Jimp 位图再压）。
import { Jimp } from "jimp";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 图 token 分档（qwen 口径三档：模型可按成本选档；发送路径缺省 2048 高档）。 */
export const IMAGE_TOKEN_BUDGET_TIERS = [256, 1024, 2048] as const;
export type ImageTokenTier = (typeof IMAGE_TOKEN_BUDGET_TIERS)[number];

/** 像素帽缺省（D3/codex MAX_DIMENSION 撞数 2048——两票共识）。 */
export const DEFAULT_MAX_EDGE = 2048;
/** 发送缺省 token 档（D3：2048 档）。 */
export const DEFAULT_TOKEN_TIER: ImageTokenTier = 2048;

/** 每 token 折算像素（GLM/GPT 视觉口径 ≈ (w*h)/750；qwen 按 28×28 patch 同量级——分档用途取近似即可）。 */
export const PIXELS_PER_TOKEN = 750;

/** token 档 → 像素预算（反解：pixels = tier × 750）。 */
export const tokenBudgetPixels = (tier: number): number => tier * PIXELS_PER_TOKEN;

export interface ResizeSpec {
  maxEdge: number;
  tokenTier: number;
}

/** 双口径缩放系数（像素帽 + token 分档取更严者）：scale = min(1, maxEdge/最长边, sqrt(预算/总像素))。 */
export function scaleFor(w: number, h: number, spec: ResizeSpec): number {
  const longest = Math.max(w, h);
  const byEdge = spec.maxEdge / longest;
  const byTokens = Math.sqrt(tokenBudgetPixels(spec.tokenTier) / (w * h));
  return Math.min(1, byEdge, byTokens);
}

/** 缩放后尺寸（向上取整、至少 1px；对齐偶数——部分编码器不喜欢奇数边）。 */
export function scaledDims(w: number, h: number, scale: number): { w: number; h: number } {
  const w2 = Math.max(1, Math.round(w * scale));
  const h2 = Math.max(1, Math.round(h * scale));
  return { w: w2 - (w2 % 2), h: h2 - (h2 % 2) };
}

/** ImageData → Jimp 位图（webp 解码产物桥接；RGBA 直拷）。 */
function jimpFromImageData(data: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }) {
  const src = data.data instanceof Uint8ClampedArray ? new Uint8Array(data.data.buffer) : data.data;
  return new Jimp({ data: Buffer.from(src), width: data.width, height: data.height });
}

const isWebp = (b: Buffer): boolean => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP";

/** wasm 就绪闸（懒加载一次；Node 下必须注入本地 wasm Module——包缺省 fetch 形态只在浏览器可用）。
 *  wasm 定位走 createRequire.resolve（import.meta.resolve 在 vitest 变换环境下不可靠）。 */
let webpReady: Promise<void> | undefined;
async function ensureWebp(): Promise<void> {
  webpReady ??= (async () => {
    const { readFile: rf } = await import("node:fs/promises");
    const { createRequire } = await import("node:module");
    const { init } = await import("@jsquash/webp/decode.js");
    const decJs = createRequire(import.meta.url).resolve("@jsquash/webp/decode.js");
    const WA = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Buffer) => WebAssembly.Module } }).WebAssembly;
    init(new WA.Module(await rf(join(dirname(decJs), "codec", "dec", "webp_dec.wasm"))));
  })();
  await webpReady;
}

/** 解码到 Jimp 位图：Jimp 原生格式直读；webp 走 wasm 解码转位图（kimi webp-decode 同源）。 */
export async function loadToJimp(buffer: Buffer) {
  if (isWebp(buffer)) {
    await ensureWebp();
    const { decode } = await import("@jsquash/webp");
    const arrayBuf = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    return jimpFromImageData(await decode(arrayBuf));
  }
  return Jimp.read(buffer);
}

/** webp 出图形态：Jimp 无 webp 编码器——发送副本统一转 png（解码能力保留、格式策略层 F6 另管端点认不认）。 */
export const OUTPUT_MIME: Record<string, "image/png" | "image/jpeg" | "image/gif"> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/gif": "image/png", // 静帧转 png
  "image/webp": "image/png", // 解码后重编码 png
};

/** 压缩执行（worker 内跑）：读 → 双口径缩放（scale ≥ 1 原样返回标记）→ 重编码。
 *  @returns 新 buffer + 实际尺寸 + 出幅 mime；scale ≥ 1 时返回 { unchanged: true }（调用方免写副本）。 */
export async function resizeBuffer(buffer: Buffer, spec: ResizeSpec): Promise<{ buffer: Buffer; width: number; height: number; mime: string; unchanged?: boolean }> {
  const img = await loadToJimp(buffer);
  const scale = scaleFor(img.width, img.height, spec);
  const mime = OUTPUT_MIME[img.mime ?? "image/png"] ?? "image/png";
  if (scale >= 1) return { buffer, width: img.width, height: img.height, mime, unchanged: true };
  const { w, h } = scaledDims(img.width, img.height, scale);
  const resized = img.resize({ w, h });
  const outMime: "image/png" | "image/jpeg" = mime === "image/jpeg" ? "image/jpeg" : "image/png";
  // getBuffer 泛型重载并集不可直呼（TS2349）——bind 后收窄到单签名（裸 as 会丢 this，formats 读 undefined 实锤）
  const encode2 = resized.getBuffer.bind(resized) as (mime: string, opts?: { quality?: number }) => Promise<Buffer>;
  const out = await encode2(outMime, outMime === "image/jpeg" ? { quality: 85 } : {});
  return { buffer: out, width: w, height: h, mime: outMime };
}

/** 读文件 + 压缩（worker 协议的文件版——测试与 inline 回落共用）。 */
export async function resizeFile(path: string, spec: ResizeSpec): Promise<{ buffer: Buffer; width: number; height: number; mime: string; unchanged?: boolean }> {
  return resizeBuffer(await readFile(path), spec);
}
