import { defineModule } from "@orosus/contracts/module";
import type { CapabilityKey } from "@orosus/contracts/module";
import { z } from "zod";
import { orosusHome } from "@orosus/contracts/home";
import { join } from "node:path";
import { createReadMediaFileTool } from "./readfile.ts";
import { createConvertTool, createCropTool, createDownsampleTool, createVideoClipTool } from "./tools.ts";
import { hasFfmpeg } from "./imaging.ts";
import { eyeModelOf, summarizeImage } from "./vision.ts";

/** 媒体策略出货形态（m5-media F9——服务倒挂双边契约）：发送路径四道闸 + 压缩口径的有效值快照。
 *  消费方 = provider-custom（translate 前的 F5 副本口径与 F6/F7 帽值）；键与形状登记于本文件常量。 */
export interface MediaPolicyFacts {
  /** 压缩像素帽（F5/D3 缺省 2048——codex MAX_DIMENSION 撞数）。 */
  maxEdge: number;
  /** token 分档（F5/D3 缺省 2048——qwen 三档 256/1024/2048）。 */
  tokenTier: 256 | 1024 | 2048;
  /** 单图发送帽字节（F7/D2 缺省 4.5MB——贴 Anthropic 5MB 留余量）。 */
  singleCapBytes: number;
  /** 请求图片总量帽（F7/D2 缺省 20MB——Anthropic 请求媒体限）。 */
  budgetBytes: number;
  /** 降级安全线（F7/D4 缺省 10MB——超帽降级到此）。 */
  safeBytes: number;
  /** 每请求张数帽（F7/D2 缺省 4 张）。 */
  maxImages: number;
  /** 眼睛模型三态（D12/F14）："off"（停用，默认）| "auto" | "<槽/模型>"。F13/F14 消费。 */
  visionModel: string;
}

const MB = 1024 * 1024;

/** 用户配置（[tool-media] 节，F9——modules.d 同族；方案文 [media] 为建议形态，节名跟模块名走）。 */
export const configSchema = z.object({
  maxEdge: z.number().int().positive().max(8192).default(2048).describe("发送副本最长边像素帽"),
  tokenTier: z.union([z.literal(256), z.literal(1024), z.literal(2048)]).default(2048).describe("token 分档（qwen 口径三档）"),
  singleCapMb: z.number().positive().max(10).default(4.5).describe("单图发送帽（MB）"),
  budgetMb: z.number().positive().max(50).default(20).describe("请求图片总量帽（MB）"),
  safeMb: z.number().positive().max(50).default(10).describe("总量降级安全线（MB）"),
  maxImages: z.number().int().positive().max(16).default(4).describe("每请求图片张数帽"),
  visionModel: z.string().default("off").describe('眼睛模型三态："off" | "auto" | "<槽/模型>"（给非多模态模型提供视觉）'),
});

/** 配置 → 策略快照（纯函数——测试与模块共用单源）。 */
export function policyOf(config: z.infer<typeof configSchema>): MediaPolicyFacts {
  return {
    maxEdge: config.maxEdge,
    tokenTier: config.tokenTier,
    singleCapBytes: Math.round(config.singleCapMb * MB),
    budgetBytes: Math.round(config.budgetMb * MB),
    safeBytes: Math.round(config.safeMb * MB),
    maxImages: config.maxImages,
    visionModel: config.visionModel,
  };
}

/** 服务 key（圈地纪律：provides 必带 <模块名>. 前缀）。 */
export const MEDIA_POLICY_KEY = "tool-media.policy" as CapabilityKey<{ current(): MediaPolicyFacts }>;

/** F13 摘要服务 key（后台预热口——tool/post-execute 自消费；外部模块亦可主动 warm）。 */
export const MEDIA_SUMMARY_KEY = "tool-media.vision-summary" as CapabilityKey<{ warm(images: { path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }[]): void }>;

export default defineModule({
  name: "tool-media",
  version: "0.1.0",
  description: "媒体处理——读图工具/媒体工具族/媒体策略（m5-media：预算帽值与压缩口径的配置源，服务倒挂供 provider-custom）",
  api: 1,
  config: configSchema,
  provides: [MEDIA_POLICY_KEY, MEDIA_SUMMARY_KEY], // F13 摘要服务同声明制
  mounts: ["provide", "contribute:tool", "hook:turn/end", "hook:tool/post-execute"], // turn/end = 宿主快照刷新；tool/post-execute = F13 后台摘要触发（emit 广播）
  activate(ctx) {
    const facts = policyOf(ctx.config);
    ctx.provide(MEDIA_POLICY_KEY, { current: () => facts });
    // 宿主快照缓存（F10 门控数据源——m5 T9 读面标准接法：activate 拉首份 + turn/end 刷新）
    let hostModel: string | undefined;
    void ctx.host?.current().then((s) => { hostModel = s.model; }).catch(() => undefined);
    ctx.events.on("turn/end", () => { void ctx.host?.current().then((s) => { hostModel = s.model; }).catch(() => undefined); });
    ctx.contribute.tool(createReadMediaFileTool({
      model: () => hostModel,
      spec: { maxEdge: facts.maxEdge, tokenTier: facts.tokenTier },
    }));
    ctx.contribute.tool(createDownsampleTool({ maxEdge: facts.maxEdge, tokenTier: facts.tokenTier }));
    ctx.contribute.tool(createCropTool({ maxEdge: facts.maxEdge, tokenTier: facts.tokenTier }));
    ctx.contribute.tool(createConvertTool());
    // F12 video_clip：ffmpeg 在场才注册（D11 注册制——缺席不挂工具，解锁条件在 readfile 占位文案明说）
    void hasFfmpeg().then((ok) => { if (ok) ctx.contribute.tool(createVideoClipTool()); });

    // F13 VisionSummary：每张进媒资库的图后台生成一次描述缓存（<名>.summary.txt）——预算降级/压缩
    // 剥图标签同步富化（读缓存零延迟）；off=不生成、auto/指定=二级调用（D12 三态，失败静默回落纯标签）。
    const catalogFile = join(orosusHome(), "cache", "models-dev.json");
    ctx.provide(MEDIA_SUMMARY_KEY, {
      warm(images: { path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }[]): void {
        const eye = eyeModelOf(facts, hostModel, catalogFile);
        if (eye.model === undefined) {
          if (facts.visionModel !== "off") ctx.log.info("tool-media.vision", eye.note ?? "眼睛模型未解析——摘要不生成");
          return;
        }
        for (const img of images) {
          void summarizeImage(img.path, img.mimeType, eye.model, {
            llmStream: (req) => ctx.llm.stream(req as never),
            catalogFile,
          }).then((t) => { if (t === undefined) ctx.log.warn("tool-media.vision", "视觉摘要生成失败——回落纯标签", { path: img.path }); });
        }
      },
    });
    ctx.events.on("tool/post-execute", (raw: unknown) => {
      const payload = raw as { result?: { images?: { path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }[] } };
      if (Array.isArray(payload?.result?.images) && payload.result!.images!.length > 0) {
        ctx.services.getOptional<never>(MEDIA_SUMMARY_KEY as never).then((svc) => {
          (svc as unknown as { warm: (i: { path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }[]) => void } | undefined)?.warm(payload.result!.images!);
        }).catch(() => undefined);
      }
    });
  },
});
