import { defineModule } from "@orosus/contracts/module";
import type { CapabilityKey } from "@orosus/contracts/module";
import { z } from "zod";

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

export default defineModule({
  name: "tool-media",
  version: "0.1.0",
  description: "媒体处理——读图工具/媒体工具族/媒体策略（m5-media：预算帽值与压缩口径的配置源，服务倒挂供 provider-custom）",
  api: 1,
  mounts: ["provide"],
  provides: [MEDIA_POLICY_KEY], // §5.2 规则 1：服务键须声明（provider 槽走核心保留槽例外——本模块无）
  config: configSchema,
  activate(ctx) {
    const facts = policyOf(ctx.config);
    ctx.provide(MEDIA_POLICY_KEY, { current: () => facts });
    // T9（ReadMediaFile）/T11（媒体工具族）工具挂载点——contribute.tool 随任务落地
  },
});
