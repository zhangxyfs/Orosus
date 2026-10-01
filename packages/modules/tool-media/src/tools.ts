// m5-media F12 媒体工具族（qwen omni 式——媒体处理本身是模型可调工具）：downsample/crop/convert
// 三图工具 + ffmpeg 在场才注册的 video_clip。处理内核复用 imaging（worker 隔离）；产物经 rawImages/
// rawVideos 通道——core 归一化落媒资库（模型可见 + TUI 信息行可见，路径可再读）。
import { readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, type Tool, type ToolResult } from "@orosus/contracts/tool";
import { loadToJimp, runProcess, sniffMime, hasFfmpeg } from "./imaging.ts";

const execFileAsync = promisify(execFile);

const READ_LIMIT_BYTES = 100 * 1024 * 1024; // 与 readfile 同帽

const run = async (tool: Tool, input: Record<string, unknown>): Promise<ToolResult> => {
  const planned = await tool.resolveExecution(input);
  return planned.execute({ callId: "c", signal: new AbortController().signal, log: { info() {}, warn() {}, error() {}, debug() {} } as never });
};
export const runMediaTool = run; // 测试口

/** 读源文件三卫戍（在场/体积/格式）——四工具共用。 */
function guard(path: string): { ok: true; bytes: Buffer; mime: NonNullable<ReturnType<typeof sniffMime>> } | { ok: false; result: ToolResult } {
  try {
    const st = statSync(path);
    if (st.size > READ_LIMIT_BYTES) return { ok: false, result: { output: `文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB 超 100MB 上限）`, isError: true } };
    const bytes = readFileSync(path);
    const mime = sniffMime(bytes);
    if (mime === undefined) return { ok: false, result: { output: `无法识别的图片格式（支持 png/jpeg/gif/webp）：${path}`, isError: true } };
    return { ok: true, bytes, mime };
  } catch {
    return { ok: false, result: { output: `文件读不到：${path}`, isError: true } };
  }
}

const kb = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} 字节`);

/** media_downsample：按 token 档缩图（256 最省/1024 常看/2048 最清）。 */
export function createDownsampleTool(spec: { maxEdge: number; tokenTier: number } = { maxEdge: 2048, tokenTier: 2048 }): Tool {
  return defineTool({
    name: "tool-media__media_downsample",
    label: "Downsample Image",
    description: `Downsample an image to a token cost tier (256 = cheapest for a quick look, 1024 = normal, 2048 = finest detail). The downsampled copy is attached so you can view it; the original file is never modified.`,
    parameters: z.object({
      path: z.string().min(1).describe("源图片路径"),
      token_tier: z.union([z.literal(256), z.literal(1024), z.literal(2048)]).default(2048).describe("目标 token 档"),
    }),
    resolveExecution: async (input) => {
      const args = input as { path: string; token_tier?: 256 | 1024 | 2048 };
      return {
        accesses: [{ kind: "fs.read", path: args.path }],
        approvalRule: "tool-media__media_downsample",
        execute: async (): Promise<ToolResult> => {
          const g = guard(args.path);
          if (!g.ok) return g.result;
          const useSpec = { maxEdge: spec.maxEdge, tokenTier: args.token_tier ?? 2048 };
          const r = await runProcess(g.bytes, useSpec);
          if (r.unchanged) return { output: `图片已在 ${useSpec.tokenTier} 档内（${r.width}×${r.height}）——无需降采样，原件可直读`, isError: false, images: [{ path: args.path, mimeType: g.mime }] };
          return { output: `已降采样 ${args.path}（${r.width}×${r.height}，${r.mime}，${kb(r.buffer.length)}）——副本随附`, isError: false, rawImages: [{ data: r.buffer.toString("base64"), mimeType: r.mime }] };
        },
      };
    },
  });
}

/** media_crop：裁区域出图（先全图后局部的两段式——走查场景直接受益）。 */
export function createCropTool(spec: { maxEdge: number; tokenTier: number } = { maxEdge: 2048, tokenTier: 2048 }): Tool {
  return defineTool({
    name: "tool-media__media_crop",
    label: "Crop Image",
    description: `Crop a rectangular region out of an image and attach the crop so you can inspect it at higher effective resolution (look at the whole image first, then crop into a detail area). The original file is never modified.`,
    parameters: z.object({
      path: z.string().min(1).describe("源图片路径"),
      x: z.number().int().min(0), y: z.number().int().min(0),
      width: z.number().int().positive(), height: z.number().int().positive(),
      token_tier: z.union([z.literal(256), z.literal(1024), z.literal(2048)]).optional().describe("裁剪副本的 token 档（缺省 2048——裁剪就是为看细节）"),
    }),
    resolveExecution: async (input) => {
      const args = input as { path: string; x: number; y: number; width: number; height: number; token_tier?: 256 | 1024 | 2048 };
      return {
        accesses: [{ kind: "fs.read", path: args.path }],
        approvalRule: "tool-media__media_crop",
        execute: async (): Promise<ToolResult> => {
          const g = guard(args.path);
          if (!g.ok) return g.result;
          try {
            const r = await runProcess(g.bytes, { maxEdge: spec.maxEdge, tokenTier: args.token_tier ?? 2048 }, { x: args.x, y: args.y, width: args.width, height: args.height });
            return { output: `已裁剪 ${args.path}（区 ${args.x},${args.y},${args.width},${args.height} → ${r.width}×${r.height}，${r.mime}，${kb(r.buffer.length)}）——副本随附`, isError: false, rawImages: [{ data: r.buffer.toString("base64"), mimeType: r.mime }] };
          } catch (err) {
            return { output: `裁剪失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
          }
        },
      };
    },
  });
}

/** media_convert：png/jpeg/webp 互转（webp 出幅走 wasm 编码器）。 */
export function createConvertTool(): Tool {
  return defineTool({
    name: "tool-media__media_convert",
    label: "Convert Image",
    description: `Convert an image between png / jpeg / webp and attach the converted copy (e.g. shrink a lossless png screenshot to webp/jpeg for cheaper delivery). The original file is never modified.`,
    parameters: z.object({
      path: z.string().min(1).describe("源图片路径"),
      to: z.enum(["image/png", "image/jpeg", "image/webp"]).describe("目标格式"),
    }),
    resolveExecution: async (input) => {
      const args = input as { path: string; to: "image/png" | "image/jpeg" | "image/webp" };
      return {
        accesses: [{ kind: "fs.read", path: args.path }],
        approvalRule: "tool-media__media_convert",
        execute: async (): Promise<ToolResult> => {
          const g = guard(args.path);
          if (!g.ok) return g.result;
          try {
            if (args.to === "image/webp") {
              // Jimp 无 webp 编码器——jsquash wasm（simd/非 simd 按 CPU 探测选二进制）
              const img = await loadToJimp(g.bytes);
              const { simd } = await import("wasm-feature-detect");
              const { init: initEnc } = await import("@jsquash/webp/encode.js");
              const { createRequire } = await import("node:module");
              const { readFile } = await import("node:fs/promises");
              const { dirname, join: j } = await import("node:path");
              const encJs = createRequire(import.meta.url).resolve("@jsquash/webp/encode.js");
              const wasmFile = await simd() ? "webp_enc_simd.wasm" : "webp_enc.wasm";
              const WA = (globalThis as unknown as { WebAssembly: { Module: new (b: Buffer) => unknown } }).WebAssembly;
              initEnc(new WA.Module(await readFile(j(dirname(encJs), "codec", "enc", wasmFile))) as never);
              const { encode } = await import("@jsquash/webp");
              const ab = img.bitmap.data.buffer.slice(img.bitmap.data.byteOffset, img.bitmap.data.byteOffset + img.bitmap.data.byteLength) as ArrayBuffer;
              const out = Buffer.from(await encode({ data: new Uint8Array(ab), width: img.width, height: img.height }, { quality: 85 }));
              return { output: `已转换 ${args.path} → image/webp（${img.width}×${img.height}，${kb(out.length)}）——副本随附`, isError: false, rawImages: [{ data: out.toString("base64"), mimeType: "image/webp" }] };
            }
            const r = await runProcess(g.bytes, { maxEdge: 8192, tokenTier: 2048 * 8 }); // 转换不过尺寸——档位放大到不触发缩放
            const encode = (await loadToJimp(g.bytes)).getBuffer.bind(await loadToJimp(g.bytes)) as (m: string, o?: { quality?: number }) => Promise<Buffer>;
            const out = await encode(args.to, args.to === "image/jpeg" ? { quality: 90 } : {});
            return { output: `已转换 ${args.path} → ${args.to}（${r.width}×${r.height}，${kb(out.length)}）——副本随附`, isError: false, rawImages: [{ data: out.toString("base64"), mimeType: args.to }] };
          } catch (err) {
            return { output: `转换失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
          }
        },
      };
    },
  });
}

/** video_clip：掐视频段（ffmpeg 在场才注册——D11 注册制；产物经 rawVideos 落媒资库）。 */
export function createVideoClipTool(): Tool {
  return defineTool({
    name: "tool-media__video_clip",
    label: "Clip Video",
    description: `Cut a segment out of a video file (ffmpeg required) and attach the clip, e.g. to re-inspect the moment an UI walkthrough failed. Times are seconds from the start.`,
    parameters: z.object({
      path: z.string().min(1).describe("源视频路径"),
      start_sec: z.number().min(0).describe("起始秒"),
      end_sec: z.number().min(0).describe("结束秒（> start_sec）"),
    }),
    resolveExecution: async (input) => {
      const args = input as { path: string; start_sec: number; end_sec: number };
      return {
        accesses: [{ kind: "fs.read", path: args.path }, { kind: "subprocess" }],
        approvalRule: "tool-media__video_clip",
        execute: async (): Promise<ToolResult> => {
          if (args.end_sec <= args.start_sec) return { output: "end_sec 必须大于 start_sec", isError: true };
          if (!(await hasFfmpeg())) return { output: "本机未装 ffmpeg——无法剪辑（安装 ffmpeg 可解锁）", isError: true };
          const dir = mkdtempSync(join(tmpdir(), "orosus-clip-"));
          try {
            const out = join(dir, "clip.mp4");
            await execFileAsync("ffmpeg", ["-y", "-ss", String(args.start_sec), "-to", String(args.end_sec), "-i", args.path, "-c", "copy", out]);
            const bytes = readFileSync(out);
            return { output: `已剪辑 ${args.path}（${args.start_sec}s → ${args.end_sec}s，${kb(bytes.length)} mp4）——片段随附`, isError: false, rawVideos: [{ data: bytes.toString("base64"), mimeType: "video/mp4" }] };
          } catch (err) {
            return { output: `剪辑失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      };
    },
  });
}
