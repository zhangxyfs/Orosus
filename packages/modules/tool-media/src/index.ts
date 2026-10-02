import { defineModule } from "@orosus/contracts/module";
import type { CapabilityKey } from "@orosus/contracts/module";
import { z } from "zod";
import { orosusHome } from "@orosus/contracts/home";
import { join } from "node:path";
import { createReadMediaFileTool } from "./readfile.ts";
import { createConvertTool, createCropTool, createDownsampleTool, createVideoClipTool } from "./tools.ts";
import { hasFfmpeg } from "./imaging.ts";
import { eyeModelOf, makeSummarizer, summarizeImage } from "./vision.ts";

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

/** F13 摘要服务 key（warm=后台预热口〔tool/post-execute 自消费〕；describe=同步等版——发送闸
 *  旁路放行前 await 落盘，首请求占位即带描述。2026-10-02 竞态修：warm 是「消息先发、摘要后到」，
 *  首答复读纯占位、主模型当传声筒复述换模型建议——用户实机复现）。 */
export type SummaryImageRef = { path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
/** 转述流式增量（A 案 2026-10-02 拍板）：kind 区分思考/正文——宿主喂「转述活动块」流式显示。 */
export type SummaryDelta = { kind: "thinking" | "text"; text: string };
export const MEDIA_SUMMARY_KEY = "tool-media.vision-summary" as CapabilityKey<{
  warm(images: SummaryImageRef[]): void;
  /** 同步等版（走查四）：返回逐图转述文本（失败图 text 缺席）——发送闸旁路等它，首请求占位即带
   *  描述、且窗口内「● 视觉转述」条目与回放事件共用同一份数据。全失败/服务异常 = 空数组。
   *  onDelta（A 案）：逐 chunk 流式增量（思考/正文）——等待期活动显示防卡死感；多图交错不分图。 */
  describe(images: SummaryImageRef[], onDelta?: (d: SummaryDelta) => void): Promise<{ path: string; text?: string }[]>;
}>;

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
    // 宿主快照缓存（m5 T9 读面标准接法：activate 拉首份 + turn/end 刷新）——但快照在**首轮 turn
    // 进行中**为空、且 /model 中途切换后到 turn/end 前陈旧（2026-10-02 实机：非视觉门因快照空没触发，
    // 白给模型投了原图）。门控判定改**执行期现读**（工具执行低频，host.current() 成本可忽略；快照
    // 兜底 host 面缺席/读失败）；快照保留给 policy/turn-end 高频路径。
    let hostModel: string | undefined;
    void ctx.host?.current().then((s) => { hostModel = s.model; }).catch(() => undefined);
    ctx.events.on("turn/end", () => { void ctx.host?.current().then((s) => { hostModel = s.model; }).catch(() => undefined); });
    const liveModel = async (): Promise<string | undefined> => {
      try { return (await ctx.host?.current())?.model ?? hostModel; } catch { return hostModel; }
    };
    ctx.contribute.tool(createReadMediaFileTool({
      model: liveModel,
      spec: { maxEdge: facts.maxEdge, tokenTier: facts.tokenTier },
      // F10×D12：主模型非视觉但眼睛模型已配 → 读图改为转述（未解析/失败回落路径指路）
      summarize: makeSummarizer(facts, liveModel, join(orosusHome(), "cache", "models-dev.json"), (req) => ctx.llm.stream(req as never),
        (path, reason) => ctx.log.warn("tool-media.vision", "read_media_file 转述失败", { path, reason })),
    }));
    ctx.contribute.tool(createDownsampleTool({ maxEdge: facts.maxEdge, tokenTier: facts.tokenTier }));
    ctx.contribute.tool(createCropTool({ maxEdge: facts.maxEdge, tokenTier: facts.tokenTier }));
    ctx.contribute.tool(createConvertTool());
    // F12 video_clip：ffmpeg 在场才注册（D11 注册制——缺席不挂工具，解锁条件在 readfile 占位文案明说）
    void hasFfmpeg().then((ok) => { if (ok) ctx.contribute.tool(createVideoClipTool()); });

    // F13 VisionSummary：每张进媒资库的图后台生成一次描述缓存（<名>.summary.txt）——预算降级/压缩
    // 剥图标签同步富化（读缓存零延迟）；off=不生成、auto/指定=二级调用（D12 三态，失败静默回落纯标签）。
    const catalogFile = join(orosusHome(), "cache", "models-dev.json");
    const summarizeAll = async (images: SummaryImageRef[], onDelta?: (d: SummaryDelta) => void): Promise<{ path: string; text?: string }[]> => {
      const eye = eyeModelOf(facts, hostModel, catalogFile);
      const m = eye.model;
      if (m === undefined) {
        if (facts.visionModel !== "off") ctx.log.info("tool-media.vision", eye.note ?? "眼睛模型未解析——摘要不生成");
        return [];
      }
      return Promise.all(images.map((img) => summarizeImage(img.path, img.mimeType, m, {
        llmStream: (req) => ctx.llm.stream(req as never),
        catalogFile,
        onFail: (reason) => ctx.log.warn("tool-media.vision", "视觉摘要生成失败——回落纯标签", { path: img.path, reason }),
        ...(onDelta !== undefined ? { onDelta } : {}),
      }).then((t): { path: string; text?: string } => (t === undefined ? { path: img.path } : { path: img.path, text: t }))));
    };
    ctx.provide(MEDIA_SUMMARY_KEY, {
      // warm=后台即发不候（工具产图预热）；describe=await 落盘（发送闸用——失败静默回落纯占位）
      warm: (images: SummaryImageRef[]): void => void summarizeAll(images),
      describe: (images: SummaryImageRef[], onDelta?: (d: SummaryDelta) => void): Promise<{ path: string; text?: string }[]> => summarizeAll(images, onDelta),
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

// F14 配置落盘件（宿主 CLI 传目标路径——settings/引导两入口共用）
export { persistVisionModel, readVisionModel } from "./persist.ts";
