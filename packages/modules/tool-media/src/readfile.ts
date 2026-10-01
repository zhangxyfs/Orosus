// m5-media F10 ReadMediaFile——模型主动读磁盘图片进对话（kimi read-media-file 同名工具）。
// 投递分档（kimi readMediaFileTool 同款四档）：untouched（达标原图路径直交）/ downsampled（降采样副本经
// rawImages 通道——core 归一化落媒资库）/ crop（裁剪副本同通道）/ full_resolution（跳过预压，线缆帽值仍守）。
// 能力门控（F4 同口径）：目录明确 false → 工具照跑但不带回图（拒发+留路径指路——三档表一档+二档）；
// true/undefined 放行。模型判定走宿主快照 model + 盘上目录（与 provider-custom/visiongate 同语义双写）。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { z } from "zod";
import { defineTool, type Tool, type ToolResult } from "@orosus/contracts/tool";
import { runProcess, sniffMime } from "./imaging.ts";

/** 读取文件上限（kimi read-media-file :10 同值 100MB）。 */
const READ_LIMIT_BYTES = 100 * 1024 * 1024;

// —— 视觉能力查表（与 provider-custom/catalog.ts lookupModelVision 同匹配口径双写：全名/尾段/id/name 四口径）——
type CatalogModel = { id?: string; name?: string; modalities?: { input?: string[] }; attachment?: boolean };
type Catalog = Record<string, { models?: Record<string, CatalogModel> }>;

function lookupVision(catalog: Catalog, model: string): boolean | undefined {
  const bare = model.includes("/") ? model.split("/").pop()! : model;
  for (const entry of Object.values(catalog)) {
    for (const [key, m] of Object.entries(entry.models ?? {})) {
      if (key === model || key === bare || key.endsWith(`/${bare}`) || m.id === model || m.id === bare || m.name === bare) {
        if (m.modalities?.input !== undefined) return m.modalities.input.includes("image");
        if (m.attachment !== undefined) return m.attachment;
        return undefined;
      }
    }
  }
  return undefined;
}

function readCatalog(catalogFile: string): Catalog | undefined {
  try {
    return (JSON.parse(readFileSync(catalogFile, "utf8")) as { catalog?: Catalog }).catalog;
  } catch {
    return undefined;
  }
}

export interface ReadMediaFileDeps {
  /** 当前模型现读口（宿主快照缓存 getter；测试注入）。undefined = 不知道（放行口径）。 */
  model?: () => string | undefined;
  /** 目录缓存路径（缺省 ~/.orosus/cache/models-dev.json；测试注入密封）。 */
  catalogFile?: string;
  /** 压缩口径（缺省 2048px + 2048 档——policyOf 缺省）。 */
  spec?: { maxEdge: number; tokenTier: number };
}

const REGION_DESC = "裁剪区（像素坐标，先全图看布局再裁一角看细节的两段式用法）";
const TIER_DESC = "成本档：256 最省（粗看）/ 1024（常看）/ 2048 最清（细节，默认）";

/** 工具工厂（模块 activate 与测试共用——deps 注入模型口/目录路径/口径）。 */
export function createReadMediaFileTool(deps: ReadMediaFileDeps = {}): Tool {
  const spec = deps.spec ?? { maxEdge: 2048, tokenTier: 2048 };
  const catalogFile = deps.catalogFile ?? join(orosusHome(), "cache", "models-dev.json");
  return defineTool({
    name: "tool-media__read_media_file",
    label: "Read Image",
    description: `Read an image file (png/jpeg/gif/webp) from disk into the conversation so you can SEE it.
Delivery tiers: image already within size caps is delivered as-is; oversized images are downsampled (longest edge ${spec.maxEdge}px, token tier ${spec.tokenTier}); use "region" to crop and inspect a detail area at higher effective resolution (look at the whole image first, then crop); use full_resolution to skip pre-downsampling (wire caps still apply).
If the current model does not support image input, this returns a path note instead of the image (switch model with /model to view).`,
    parameters: z.object({
      path: z.string().min(1).describe("图片文件的绝对路径"),
      region: z.object({
        x: z.number().int().min(0), y: z.number().int().min(0),
        width: z.number().int().positive(), height: z.number().int().positive(),
      }).optional().describe(REGION_DESC),
      token_tier: z.union([z.literal(256), z.literal(1024), z.literal(2048)]).optional().describe(TIER_DESC),
      full_resolution: z.boolean().optional().describe("真 = 跳过预降采样（线缆帽值仍守）；缺省 false"),
    }),
    resolveExecution: async (input) => {
      const args = input as { path: string; region?: { x: number; y: number; width: number; height: number }; token_tier?: 256 | 1024 | 2048; full_resolution?: boolean };
      return {
        accesses: [{ kind: "fs.read", path: args.path }],
        approvalRule: "tool-media__read_media_file",
        execute: async (): Promise<ToolResult> => {
          // 基本卫戍：在场 / 体积帽 / 格式
          let bytes: Buffer;
          try {
            const st = statSync(args.path);
            if (st.size > READ_LIMIT_BYTES) return { output: `图片过大（${(st.size / 1024 / 1024).toFixed(1)}MB 超过 100MB 上限）——不读入`, isError: true };
            bytes = readFileSync(args.path);
          } catch {
            return { output: `图片文件读不到：${args.path}`, isError: true };
          }
          const mime = sniffMime(bytes);
          if (mime === undefined) return { output: `无法识别的图片格式（支持 png/jpeg/gif/webp）：${args.path}`, isError: true };
          // 能力门控（F4 口径：明确 false 才拦——拒发+留路径指路；true/undefined 放行）
          const model = deps.model?.();
          if (model !== undefined && lookupVision(readCatalog(catalogFile) ?? {}, model) === false) {
            return { output: `当前模型（${model}）不支持图片输入——图已存 ${args.path}，/model 换视觉模型后可查看`, isError: false };
          }
          const useSpec = { maxEdge: spec.maxEdge, tokenTier: args.token_tier ?? spec.tokenTier };
          try {
            const r = await runProcess(bytes, useSpec, args.region);
            if (r.unchanged && args.region === undefined) {
              // untouched 档：原图路径直交（发送副本机制在线缆侧按需生成——这里零拷贝零副本）
              return { output: `已读入图片 ${args.path}（${r.width}×${r.height} ${mime}，原图投递）`, isError: false, images: [{ path: args.path, mimeType: mime }] };
            }
            const tierNote = args.region !== undefined
              ? `裁剪区 (${args.region.x},${args.region.y},${args.region.width},${args.region.height}) → ${r.width}×${r.height}`
              : `降采样 → ${r.width}×${r.height}${args.full_resolution === true ? "（全分辨率原图已随附）" : ""}`;
            const out: ToolResult = { output: `已读入图片 ${args.path}（${tierNote}，${r.mime}）`, isError: false };
            if (args.full_resolution === true && args.region === undefined) {
              return { ...out, images: [{ path: args.path, mimeType: mime }] }; // full 档：原件直交（线缆帽值仍守）
            }
            return { ...out, rawImages: [{ data: r.buffer.toString("base64"), mimeType: r.mime }] }; // downsampled/crop 档：core 归一化落媒资库
          } catch (err) {
            return { output: `图片处理失败（${err instanceof Error ? err.message : String(err)}）——原图已存 ${args.path}`, isError: true };
          }
        },
      };
    },
  });
}

