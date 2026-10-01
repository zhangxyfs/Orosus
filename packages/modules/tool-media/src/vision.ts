// m5-media F13 VisionSummary（Reasonix 式——非 vision 模型也能消化历史图）：图片进媒资库后**后台**生成
// 一段文字描述缓存（<原图名>.summary.txt 同目录），预算降级/压缩剥图标签随后同步读取富化——
// 请求路径零延迟（缓存文件在就带、不在就纯标签回落）。眼睛模型三态（D12）：
//   off（默认）= 不生成，标签回落纯路径；auto = 当前模型 vision 则直用（跨槽自动挑需读 [provider-custom]
//   配置——模块 config 隔离不可达，诚实降级：非 vision 时回落并 warn）；"<槽/模型>" = 指定二级调用。
// 二级调用末条必须显式 user 指令（compaction v3 实锤坑——assistant 结尾+无 tools 被端点当接话空产出）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Chunk } from "@orosus/contracts/provider";
import type { MediaPolicyFacts } from "./index.ts";

export interface VisionSummaryDeps {
  /** 二级模型流（ctx.llm.stream——D39 口，model 字段按值解析槽）。 */
  llmStream: (req: { model: string; system: string; messages: { role: "user"; content: ({ kind: "text"; text: string } | { kind: "image"; path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" })[] }[]; tools: never[]; signal: AbortSignal; maxTokens?: number }) => AsyncIterable<Chunk>;
  /** 目录缓存路径（vision 判定——auto 档用）。 */
  catalogFile?: string;
}

/** 眼睛模型解析（D12 三态——policy.visionModel + 当前模型 + 目录 vision 判定）。 */
export function resolveEyeModel(
  policyVision: string,
  hostModel: string | undefined,
  modelIsVision: (model: string) => boolean | undefined,
): { model?: string; note?: string } {
  if (policyVision === "off") return {};
  if (policyVision === "auto") {
    if (hostModel === undefined) return { note: "auto 档拿不到当前模型——回落纯标签" };
    if (modelIsVision(hostModel) === true) return { model: hostModel, note: "auto：当前模型即视觉模型——直用" };
    return { note: "auto：当前模型非视觉（跨槽自动挑需读 provider 配置，模块隔离不可达）——回落纯标签" };
  }
  return { model: policyVision, note: `指定眼睛模型 ${policyVision}` };
}

/** 摘要缓存路径（<原图名>.summary.txt 同目录——降级/压缩标签同步读取侧的约定）。 */
export const summaryPathOf = (imagePath: string): string => `${imagePath}.summary.txt`;

/** 同步读取缓存摘要（标签富化侧——无缓存返回 undefined，纯标签回落）。 */
export function readSummary(imagePath: string): string | undefined {
  try {
    const p = summaryPathOf(imagePath);
    if (!existsSync(p)) return undefined;
    const t = readFileSync(p, "utf8").trim();
    return t === "" ? undefined : t;
  } catch {
    return undefined;
  }
}

const SUMMARY_PROMPT = "用一两句话客观描述这张图（界面元素/文字要点/显著颜色与布局）。不要猜测图外信息，直接给描述，不要前缀。";

/** 生成并缓存一张图的视觉摘要（后台调用——失败静默 undefined 回落纯标签，绝不炸）。 */
export async function summarizeImage(
  imagePath: string,
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
  eyeModel: string,
  deps: VisionSummaryDeps,
): Promise<string | undefined> {
  if (readSummary(imagePath) !== undefined) return readSummary(imagePath); // 已缓存
  try {
    let text = "";
    const stream = deps.llmStream({
      model: eyeModel,
      system: "你是图片描述器。",
      messages: [{ role: "user", content: [{ kind: "text", text: SUMMARY_PROMPT }, { kind: "image", path: imagePath, mimeType }] }],
      tools: [],
      signal: AbortSignal.timeout(60_000),
      maxTokens: 300,
    });
    for await (const c of stream) {
      if (c.type === "text/delta") text += c.text;
      if (c.type === "finish" && c.kind === "error") return undefined;
    }
    const clean = text.trim().slice(0, 500);
    if (clean === "") return undefined;
    try {
      writeFileSync(summaryPathOf(imagePath), clean, { mode: 0o600 });
    } catch { /* 缓存写失败不影响返回值（本次直接用） */ }
    return clean;
  } catch {
    return undefined;
  }
}

/** policy 便捷面：facts + 当前模型 → 眼睛模型现算（激活期/事件期共用）。 */
export function eyeModelOf(facts: MediaPolicyFacts, hostModel: string | undefined, catalogFile: string): { model?: string; note?: string } {
  return resolveEyeModel(facts.visionModel, hostModel, (m) => {
    try {
      const doc = JSON.parse(readFileSync(catalogFile, "utf8")) as { catalog?: Record<string, { models?: Record<string, { id?: string; name?: string; modalities?: { input?: string[] }; attachment?: boolean }> }> };
      const bare = m.includes("/") ? m.split("/").pop()! : m;
      for (const entry of Object.values(doc.catalog ?? {})) {
        for (const [key, mm] of Object.entries(entry.models ?? {})) {
          if (key === m || key === bare || key.endsWith(`/${bare}`) || mm.id === m || mm.id === bare || mm.name === bare) {
            if (mm.modalities?.input !== undefined) return mm.modalities.input.includes("image");
            if (mm.attachment !== undefined) return mm.attachment;
            return undefined;
          }
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  });
}
