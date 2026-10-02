// m5-media F13 VisionSummary（Reasonix 式——非 vision 模型也能消化历史图）：图片进媒资库后**后台**生成
// 一段文字描述缓存（<原图名>.summary.txt 同目录），预算降级/压缩剥图标签随后同步读取富化——
// 请求路径零延迟（缓存文件在就带、不在就纯标签回落）。眼睛模型三态（D12）：
//   off（默认）= 不生成，标签回落纯路径；auto = 当前模型 vision 则直用（跨槽自动挑需读 [provider-custom]
//   配置——模块 config 隔离不可达，诚实降级：非 vision 时回落并 warn）；"<槽/模型>" = 指定二级调用。
// 二级调用末条必须显式 user 指令（compaction v3 实锤坑——assistant 结尾+无 tools 被端点当接话空产出）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Chunk } from "@orosus/contracts/provider";
import type { MediaPolicyFacts } from "./index.ts";
import { runProcess } from "./imaging.ts";

export interface VisionSummaryDeps {
  /** 二级模型流（ctx.llm.stream——D39 口，model 字段按值解析槽）。 */
  llmStream: (req: { model: string; system: string; messages: { role: "user"; content: ({ kind: "text"; text: string } | { kind: "image"; path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" })[] }[]; tools: never[]; signal: AbortSignal; maxTokens?: number }) => AsyncIterable<Chunk>;
  /** 目录缓存路径（vision 判定——auto 档用）。 */
  catalogFile?: string;
  /** 失败观测口（2026-10-02 转述失败诊断批）：每次尝试失败带原因（重试中含退避标注）——宿主接
   *  ctx.log.warn。修复前 warn 只落路径不落因，200ms 瞬败定不了性（限流？新文件读竞态？）的盲区就是它。 */
  onFail?: (reason: string) => void;
  /** 重试退避表（缺省 [1s, 2s]——测试注入短表提速）。 */
  retryBackoffMs?: number[];
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

// 瞬时故障重试（2026-10-02 转述失败诊断批）：实机 200ms 瞬败、11 秒后同路径成功——限流/新文件读
// 竞态类自愈型故障，两退避重试把它吃掉（发送闸还在等——对用户只是转述慢一两秒，不再是失败行）。
// 鉴权/模型不存在类重试也是白花（NON_RETRYABLE）——靠 attemptOnce 带出的 reason 分类。
const DEFAULT_RETRY_BACKOFF_MS = [1_000, 2_000];
const NON_RETRYABLE_REASON = /(?:\b401\b|\b403\b|invalid[ _-]?api[ _-]?key|unauthorized|forbidden|model[ _-]?not[ _-]?(?:found|exist)|no such model|permission[ _-]?denied)/i;

/** 单次尝试：产出清洗文本或失败原因（诊断带因——不再吞错误串）。 */
const attemptOnce = async (
  imagePath: string,
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
  eyeModel: string,
  deps: VisionSummaryDeps,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
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
      if (c.type === "finish" && c.kind === "error") return { ok: false, reason: String((c as { errorMessage?: string }).errorMessage ?? "流带内错误（finish/error 无原因串）") };
    }
    const clean = text.trim().slice(0, 500);
    if (clean === "") return { ok: false, reason: "空产出（流正常结束但无文本）" };
    return { ok: true, text: clean };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
};

// 转述前预降采样（2026-10-02 拍板「再改功能」）：线缆侧预算门只在超帽（单图 4.5MB/总量 20MB）时才压
// ——贴一张 3000px 大截图（未超帽）会以原分辨率发给眼睛模型，白付高分辨率图 token。描述任务用不着
// 细节，过一道「常看档」（tier 1024 ≈ ≤768k 像素，maxEdge 2048 同 readfile 缺省帽）再发；小图
// unchanged 直用原路径零拷贝；处理失败回落原图（转述可用性优先于省钱）。
const EYE_RESIZE_SPEC = { maxEdge: 2048, tokenTier: 1024 };
const eyeCopyOf = async (
  imagePath: string,
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
): Promise<{ path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }> => {
  try {
    const r = await runProcess(readFileSync(imagePath), EYE_RESIZE_SPEC);
    if (r.unchanged) return { path: imagePath, mimeType };
    const out = `${imagePath}.eye.${r.mime === "image/jpeg" ? "jpg" : "png"}`;
    writeFileSync(out, r.buffer);
    return { path: out, mimeType: r.mime };
  } catch {
    return { path: imagePath, mimeType };
  }
};

// 进行中去重（2026-10-02 拍板）：同一图并发摘要（中止后秒内重发等小窗口）共享同一次调用——缓存
// 去重只挡已落盘，进行中的重复请求会双花视觉 token（图片输入 token 已计费，省的就是这次）。
// 键 = 图片路径（缓存文件同键）；失败/超时 finally 出表（不缓存失败——下次调用照常重试）。
const summarizing = new Map<string, Promise<string | undefined>>();

/** 生成并缓存一张图的视觉摘要（后台调用——失败静默 undefined 回落纯标签，绝不炸）。 */
export async function summarizeImage(
  imagePath: string,
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
  eyeModel: string,
  deps: VisionSummaryDeps,
): Promise<string | undefined> {
  const cached = readSummary(imagePath);
  if (cached !== undefined) return cached; // 已缓存
  const running = summarizing.get(imagePath);
  if (running !== undefined) return running; // 进行中——共享同一次调用
  const p = (async (): Promise<string | undefined> => {
    const backoff = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const eye = await eyeCopyOf(imagePath, mimeType); // 大图先降采样再发（省眼睛模型图 token）
    for (let attempt = 0; ; attempt++) {
      const r = await attemptOnce(eye.path, eye.mimeType, eyeModel, deps);
      if (r.ok) {
        try {
          writeFileSync(summaryPathOf(imagePath), r.text, { mode: 0o600 });
        } catch { /* 缓存写失败不影响返回值（本次直接用） */ }
        return r.text;
      }
      const retrying = attempt < backoff.length && !NON_RETRYABLE_REASON.test(r.reason);
      deps.onFail?.(retrying ? `${r.reason}——第 ${attempt + 1} 次失败，${backoff[attempt]}ms 后重试` : r.reason);
      if (!retrying) return undefined;
      await new Promise((res) => setTimeout(res, backoff[attempt]));
    }
  })().finally(() => summarizing.delete(imagePath));
  summarizing.set(imagePath, p);
  return p;
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

/** F10×D12 眼睛转述口装配（模块 activate 用——read_media_file 的 summarize dep）：
 *  调用期解析眼睛模型（hostModelGet **执行期现读**〔2026-10-02 修复——快照式在首轮 turn 进行中为空，
 *  auto 档因此解析不出眼睛〕，同步 getter 兼容），未解析/生成失败 = undefined（调用方回落路径指路）。
 *  onFail 透传诊断原因（宿主接 ctx.log.warn——2026-10-02 诊断批）。 */
export function makeSummarizer(
  facts: MediaPolicyFacts,
  hostModelGet: () => string | undefined | Promise<string | undefined>,
  catalogFile: string,
  llmStream: VisionSummaryDeps["llmStream"],
  onFail?: (path: string, reason: string) => void,
): (path: string, mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif") => Promise<string | undefined> {
  return async (path, mimeType) => {
    const eye = eyeModelOf(facts, await hostModelGet(), catalogFile);
    if (eye.model === undefined) return undefined;
    return summarizeImage(path, mimeType, eye.model, { llmStream, catalogFile, ...(onFail !== undefined ? { onFail: (reason) => onFail(path, reason) } : {}) });
  };
}
