// m5-media F6 格式策略 + F7 预算降级（kimi applyMediaBudget :172-233 收窄版 + cc-haha attachment 帽值对表）：
// 请求组装期最后防线——四道闸门依次过：① mime 门控（端点认不认）② 单图帽 4.5MB（贴 Anthropic 5MB 留余量）
// ③ 张数帽 4 张/请求 ④ 总量帽 20MB 超线降级到安全线 10MB（从最老开始）。被降级的图换文字标签
// `<image path="…">`——信息不丢（路径在，模型想看可再读；T12 会在此标签挂视觉摘要）。
// 纯函数 + 判定确定性：同一消息序列两次过闸结果一致（老图恒老——不存在 kimi 备忘录式的横跳面）。
import { statSync } from "node:fs";
import type { ContentPart, ModelMessage } from "@orosus/contracts/provider";

type ImagePart = Extract<ContentPart, { kind: "image" }>;

/** 默认帽值（D2 定稿实数对表）：单图 4.5MB / 请求总帽 20MB / 安全线 10MB / 4 张。 */
export const SINGLE_IMAGE_CAP_BYTES = 4.5 * 1024 * 1024;
export const REQUEST_MEDIA_BUDGET_BYTES = 20 * 1024 * 1024;
export const REQUEST_MEDIA_BUDGET_LOW_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 4;

/** 两协议族缺省都认四白名单格式（image_url data URL / base64 source 皆标准件）；端点特殊时按槽配置收紧。 */
export const DEFAULT_ACCEPTED_IMAGE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface MediaBudgetOptions {
  /** 端点认的图片 mime（F6 格式策略）；缺省四白名单。显式 undefined 合法（exactOptionalPropertyTypes 直传面）。 */
  acceptedMimes?: readonly string[] | undefined;
  singleCapBytes?: number | undefined;
  budgetBytes?: number | undefined;
  safeBytes?: number | undefined;
  maxImages?: number | undefined;
  /** 文件体积取数口（缺省 statSync；测试注入）。 */
  sizeOf?: (path: string) => number | undefined;
}

const fileSize = (path: string): number | undefined => {
  try {
    return statSync(path).size;
  } catch {
    return undefined; // 读不到（文件缺失）——translate 层自有缺失降级，这里不当大图处理
  }
};

/** 降级标签（kimi replaceWithMediaTag 形态；T12 VisionSummary 挂同位）。 */
export const imageTag = (path: string, reason?: string): string =>
  reason === undefined ? `<image path="${path}">` : `<image path="${path}" reason="${reason}">`;

const partsOf = (m: ModelMessage): ImagePart[] =>
  m.role === "toolResult" ? (m.parts ?? []).filter((p): p is ImagePart => p.kind === "image") : m.content.filter((p): p is ImagePart => p.kind === "image");

/**
 * 预算与策略闸（translate 前最后一步，prepareImagesForWire 之后——副本体积才是真实发送体积）。
 * 无图消息原引用直返（零开销）；全部达标也原引用直返（常用路径零分配）。
 */
export function applyMediaBudget(messages: ModelMessage[], opts: MediaBudgetOptions = {}): ModelMessage[] {
  const accepted = opts.acceptedMimes ?? DEFAULT_ACCEPTED_IMAGE_MIMES;
  const singleCap = opts.singleCapBytes ?? SINGLE_IMAGE_CAP_BYTES;
  const budget = opts.budgetBytes ?? REQUEST_MEDIA_BUDGET_BYTES;
  const safe = opts.safeBytes ?? REQUEST_MEDIA_BUDGET_LOW_BYTES;
  const maxImages = opts.maxImages ?? MAX_IMAGES_PER_REQUEST;
  const sizeOf = opts.sizeOf ?? fileSize;

  const all = messages.flatMap(partsOf);
  if (all.length === 0) return messages;

  // 前置判定：算出要降级的 path 集合（按消息序 = 时间序，最老在前）
  const degrade = new Map<string, string>(); // path → 原因
  const survivors: { path: string; bytes: number }[] = [];
  for (const p of all) {
    if (degrade.has(p.path)) continue; // 同图多处引用：一处降级处处降级（一致体验）
    if (!accepted.includes(p.mimeType)) {
      degrade.set(p.path, `该端点不认 ${p.mimeType}`);
      continue;
    }
    const bytes = sizeOf(p.path);
    if (bytes === undefined) continue; // 文件缺失——translate 层降级占位处理，不占预算
    if (bytes > singleCap) {
      degrade.set(p.path, `${(bytes / 1024 / 1024).toFixed(1)}MB 超单图帽`);
      continue;
    }
    survivors.push({ path: p.path, bytes });
  }
  // 张数帽：只留最新 maxImages 张（老图标签化——路径仍在可再读）
  if (survivors.length > maxImages) {
    for (const s of survivors.slice(0, survivors.length - maxImages)) degrade.set(s.path, `超过每次 ${maxImages} 张上限`);
  }
  // 总量帽：超预算从最老降级到安全线（kimi 20MB→10MB 同款）
  let total = survivors.reduce((n, s) => n + s.bytes, 0);
  if (total > budget) {
    for (const s of survivors) {
      if (total <= safe) break;
      if (degrade.has(s.path)) continue;
      degrade.set(s.path, "请求图片总量超预算");
      total -= s.bytes;
    }
  }
  if (degrade.size === 0) return messages;

  const swap = (parts: ContentPart[]): ContentPart[] =>
    parts.map((p) => (p.kind === "image" && degrade.has(p.path) ? { kind: "text" as const, text: imageTag(p.path, degrade.get(p.path)) } : p));
  return messages.map((m): ModelMessage => {
    if (m.role === "toolResult") {
      if (m.parts === undefined || !m.parts.some((p) => p.kind === "image" && degrade.has(p.path))) return m;
      return { ...m, parts: swap(m.parts) };
    }
    if (!m.content.some((p) => p.kind === "image" && degrade.has(p.path))) return m;
    return { ...m, content: swap(m.content) };
  });
}
