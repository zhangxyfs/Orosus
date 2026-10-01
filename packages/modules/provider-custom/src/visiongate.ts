import type { ContentPart, ModelMessage } from "@orosus/contracts/provider";
import { statSync } from "node:fs";
import { defaultCatalogCacheFile, lookupModelVision, readCatalogDiskCache, type Catalog } from "./catalog.ts";

/** 非图模型占位文案（m5-media F4——形态照 main.ts Alt+V 拦截文案先例：通用指路「/model 换视觉模型」，
 *  不含具体模型名）。路径在——信息不丢，换模型后可再读（三档口诀的二档「东西在哪别丢」）。 */
export const nonVisionImagePlaceholder = (path: string): string =>
  `[当前模型不支持图片输入——图片已存 ${path}，/model 换视觉模型后可查看]`;

/** 图/视频部件剥除（纯函数）：user/assistant 的 content 与 toolResult 的 parts 中的 image/video part
 *  → 文本占位。只在调用方已判定 vision === false 时使用（本函数不查目录）——非视觉模型视频同样看不见。 */
export function stripImageParts(
  messages: ModelMessage[],
  placeholder: (path: string) => string = nonVisionImagePlaceholder,
): ModelMessage[] {
  const swap = (parts: ContentPart[]): ContentPart[] =>
    parts.map((p) => (p.kind === "image" || p.kind === "video" ? { kind: "text" as const, text: placeholder(p.path) } : p));
  return messages.map((m): ModelMessage => {
    if (m.role === "toolResult") {
      if (m.parts === undefined || !m.parts.some((p) => p.kind === "image")) return m;
      return { ...m, parts: swap(m.parts) };
    }
    if (!m.content.some((p) => p.kind === "image")) return m;
    return { ...m, content: swap(m.content) };
  });
}

const hasAnyImage = (messages: ModelMessage[]): boolean => messages.some((m) =>
  m.role === "toolResult"
    ? (m.parts ?? []).some((p) => p.kind === "image" || p.kind === "video")
    : m.content.some((p) => p.kind === "image" || p.kind === "video"),
);

// 目录读缓存 memo（发送路径每次请求都可能走——statSync 命中 mtime 即复用解析结果，文件未变零重读）
let memo: { file: string; mtimeMs: number; catalog: Catalog | undefined } | undefined;

function readCatalog(file: string): Catalog | undefined {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (memo?.file === file && memo.mtimeMs === mtimeMs) return memo.catalog;
    const catalog = readCatalogDiskCache(file); // 读不到/坏 JSON → undefined（放行）
    memo = { file, mtimeMs, catalog };
    return catalog;
  } catch {
    return undefined; // 文件不在（从未拉取目录）——放行
  }
}

/**
 * 请求组装期图片门控（m5-media F4）：目录**明确**判定模型不支持图片（=== false）→ 全部 image part
 * 换文本占位（工具照跑、图不随请求发——省体积 + 防 400 坏消息落历史每轮重发会话报废）；
 * true / undefined（不知道——自架模型）原样放行（tui 批 F5 二轮⑭ 拍板语义，自架 vision 不误伤）。
 * 数据源 = 盘上目录缓存（发送路径不走网络；与 main.ts Alt+V 拦截段同口径）。无图请求零开销直返。
 */
export function gateImagesByVision(model: string, messages: ModelMessage[], catalogFile?: string): ModelMessage[] {
  if (!hasAnyImage(messages)) return messages; // 无图零开销（多数请求）——目录读/解析全免
  const file = catalogFile ?? defaultCatalogCacheFile();
  if (lookupModelVision(readCatalog(file) ?? {}, model) !== false) return messages;
  return stripImageParts(messages);
}

/** 测试专用：清目录 memo（模拟进程冷启动）。 */
export function resetVisionGateForTest(): void {
  memo = undefined;
}
