import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@orosus/contracts/module";
import type { ToolImageMime, ToolResultImage } from "@orosus/contracts/tool";

/** 内联图单块帽（m5-media F2，kimi MCP_MAX_BINARY_PART_BYTES 同值 10MB）：超限丢弃——通常是无裁剪的
 *  全屏高 DPI 截图，落盘与降采样都救不回合理体积。产出侧（mcp 桥）占位行会如实说明超限未带回。 */
export const RAW_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;

/** base64 折算字节（padded base64 ≈ 4/3 膨胀；mcp 桥占位行同口径）。 */
export const base64Bytes = (data: string): number => Math.max(0, Math.floor((data.length * 3) / 4));

const EXT: Record<ToolImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const isToolImageMime = (m: unknown): m is ToolImageMime =>
  m === "image/png" || m === "image/jpeg" || m === "image/webp" || m === "image/gif";

/**
 * rawImages 归一化的落盘半件（m5-media F2——pi normalizeToolResultImages「进历史前归一化」的持久层）：
 * base64 内联图写入会话媒资库（<dir>/media-<seq>-<safe>.<ext>，seq 由调用方registry 实例内单调计数——
 * callId 是 provider 流外部值可跨轮复用，CX-06 同款教训）→ 返回路径引用。单条失败（坏 data/非白名单
 * mime/超帽/写盘失败）剔除 + log warn，不炸（工具契约错误带内）；目录创建失败 = 全部丢弃一次 warn。
 * T6 将在此挂尺寸归一（发送副本压缩，原件不动）。
 */
export function persistRawImages(
  raw: readonly { data: string; mimeType: ToolImageMime }[],
  opts: { dir: string; seq: () => number; callId: string; log: Logger },
): ToolResultImage[] {
  const out: ToolResultImage[] = [];
  const safe = opts.callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "call";
  try {
    mkdirSync(opts.dir, { recursive: true });
  } catch (err) {
    opts.log.warn("kernel.tool.media-dir-failed", `媒资目录创建失败（${err instanceof Error ? err.message : String(err)}）——内联图全部丢弃`, { dir: opts.dir, call: opts.callId });
    return out;
  }
  for (const img of raw) {
    if (typeof img?.data !== "string" || img.data === "" || !isToolImageMime(img?.mimeType)) {
      opts.log.warn("kernel.tool.media-skip", "内联图条目无效（空数据/非白名单 mime）——剔除", { call: opts.callId });
      continue;
    }
    if (base64Bytes(img.data) > RAW_IMAGE_LIMIT_BYTES) {
      opts.log.warn("kernel.tool.media-oversize", `内联图超 ${Math.floor(RAW_IMAGE_LIMIT_BYTES / 1024 / 1024)}MB 帽——丢弃`, { call: opts.callId, mime: img.mimeType, bytes: base64Bytes(img.data) });
      continue;
    }
    const path = join(opts.dir, `media-${opts.seq()}-${safe}.${EXT[img.mimeType]}`);
    try {
      writeFileSync(path, Buffer.from(img.data, "base64"), { mode: 0o600 });
      out.push({ path, mimeType: img.mimeType });
    } catch (err) {
      opts.log.warn("kernel.tool.media-write-failed", `内联图落盘失败（${err instanceof Error ? err.message : String(err)}）——跳过该图`, { path, call: opts.callId });
    }
  }
  return out;
}
