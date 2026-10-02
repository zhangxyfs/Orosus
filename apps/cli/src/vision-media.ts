import { join } from "node:path";
import type { Harness } from "@orosus/core";
import { pasteImage, imageChipLabel } from "./paste.ts";
import { lookupModelVision, readCatalogDiskCache, defaultCatalogCacheFile, defaultMenuDeps } from "@orosus/provider-custom";
import { persistVisionModel, readVisionModel } from "@orosus/tool-media";
import { moduleConfigFileFor } from "./config-face.ts";

/** Alt+V 取图落点（m5-media F8）：当前会话媒资库 <sid>/media/（随桶清理）；会话未就绪/切换中回落旧 tmp 位。
 *  m5-split-main T4：自 main.ts 搬入；sessionsDir/sessionId 原为模块级单例直读，改经参数注入（D2——
 *  调用点闭包现取，取值时机与搬移前一致）。 */
export const pasteImageToMedia = (dir: string, sessionId: string): Promise<{ file: string } | undefined> => {
  try {
    return pasteImage(join(dir, sessionId, "media"));
  } catch {
    return pasteImage();
  }
};

// Alt + V 挂起的图片注册表（2026-09-23 走查拍板重构）：seq → 文件（序号会话内累计）；
// chip [image #N (宽×高)] 全屏期是输入框文内 token（光标位插入、可删），行模式期是挂起序号列
//（pendingLineSeqs——行模式输入不经 token）。提交时从文本 token/行模式列收集 seq → 查表取文件。
// m5-split-main T4：注册表与序号列随族搬入；可变量经访问器（get/reset + imageSeqNow）注入 main.ts（D2）。
export const pendingImageFiles = new Map<number, string>();
let pendingLineSeqs: number[] = [];
let imageSeq = 0;
export const pendingLineSeqsRef = (): number[] => pendingLineSeqs;
export const resetPendingLineSeqs = (): void => { pendingLineSeqs = []; };
export const imageSeqNow = (): number => imageSeq;
export const attachPendingImage = (file: string): string => {
  imageSeq++;
  pendingImageFiles.set(imageSeq, file);
  return imageChipLabel(imageSeq, file);
};

/** 已配置槽的多模态模型清单（F14——§2.5 遮蔽坑免疫：按槽条目内**精确键**逐槽查，禁全目录尾段扫；
 *  live /models 出的目录外模型无法验视觉能力——不列〔诚实〕；目录缺席 = 空清单走空态指路）。 */
export const visionCandidates = async (): Promise<string[]> => {
	const providers = await defaultMenuDeps().loadProviders();
	const catalog = readCatalogDiskCache(defaultCatalogCacheFile()) ?? {}; // 与拦截段同源（provider-custom 盘上缓存口）
	const out: string[] = [];
	for (const slot of Object.keys(providers)) {
		const entry = catalog[slot];
		if (entry === undefined) continue;
		for (const [key, m] of Object.entries(entry.models ?? {})) {
			if (m.modalities?.input?.includes("image") === true) out.push(`${slot}/${key}`);
		}
	}
	return out;
};

/** F14 视觉模型配置流（chooseVia = 子代理三件同款双态抽象）。D12 三态；写盘后 /reload 生效（模块配置）。 */
export const runVisionSetting = async (
	chooseVia: (title: string, items: string[]) => Promise<string>,
	configFile: () => string,
): Promise<{ wrote: boolean; message: string }> => {
	const cur = readVisionModel(configFile());
	const curNote = cur === "off" ? "停用" : cur === "auto" ? "自动" : cur;
	const OPTS = ["停用（默认——不生成视觉摘要，降级图只留路径标签）", "自动（当前模型支持图片时直接用它）", "指定模型（从已配置提供商的多模态模型中选）"];
	const picked = await chooseVia(`配置视觉模型（当前：${curNote}）`, OPTS);
	if (picked === OPTS[0]) {
		persistVisionModel(configFile(), "off");
		return { wrote: true, message: "已设为停用" };
	}
	if (picked === OPTS[1]) {
		persistVisionModel(configFile(), "auto");
		return { wrote: true, message: "已设为自动" };
	}
	const candidates = await visionCandidates();
	if (candidates.length === 0) {
		return { wrote: false, message: "已配置的提供商里没有目录可证的多模态模型——先 /provider 配置视觉模型所在的提供商（或给模型正确的目录名）" };
	}
	const model = await chooseVia("指定视觉模型（多模态模型 · 已按提供商过滤）", candidates);
	persistVisionModel(configFile(), model);
	return { wrote: true, message: `已指定视觉模型 ${model}` };
};

/** F14 眼睛模型可用性（发送闸旁路判定——与 tool-media/vision.ts eyeModelOf 同判定口径的 CLI 侧实读）：
 *  读 [tool-media] visionModel 三态：off=未配置；auto=当前模型视觉才可用（跨槽挑模块侧不可达，同收窄口径）；
 *  指定=槽已配置且目录**条目内精确键**证实多模态（遮蔽坑免疫）。configured=true 但 usable=false 时 why 带原因。
 *  m5-split-main T4：自 main.ts 搬入，h 经参数注入（D2）。 */
export const eyeModelUsable = async (
  modelNow: string,
  catalogAll: import("@orosus/provider-custom").Catalog,
  h: Harness,
): Promise<{ configured: boolean; usable: boolean; model?: string; why?: string }> => {
  const v = readVisionModel(moduleConfigFileFor("tool-media", h));
  if (v === "off") return { configured: false, usable: false };
  if (v === "auto") {
    if (lookupModelVision(catalogAll, modelNow) === true) return { configured: true, usable: true, model: modelNow };
    return { configured: true, usable: false, why: `auto 档且当前模型 ${modelNow || "（未配置）"} 非视觉` };
  }
  const slot = v.split("/")[0] ?? "";
  const key = v.slice(slot.length + 1);
  const providers = await defaultMenuDeps().loadProviders();
  if (providers[slot] === undefined) return { configured: true, usable: false, why: `槽 "${slot}" 未配置` };
  const mm = catalogAll[slot]?.models?.[key];
  if (mm === undefined) return { configured: true, usable: false, why: `目录无 ${v}` };
  if (mm.modalities?.input?.includes("image") !== true) return { configured: true, usable: false, why: `目录证实 ${v} 非多模态` };
  return { configured: true, usable: true, model: v };
};

/** 扩展名 → 图片 mime（describe 参数用——贴图/媒资库件均按扩展名落盘）。 */
export const extImageMime = (path: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" => {
  const e = path.slice(path.lastIndexOf(".")).toLowerCase();
  return e === ".jpg" || e === ".jpeg" ? "image/jpeg" : e === ".webp" ? "image/webp" : e === ".gif" ? "image/gif" : "image/png";
};

/** 转述等待结果（走查四）：done=至少一图转述成功（text=逐图文本聚合）；failed=全失败/服务缺席
 *  （回落纯占位照发）；aborted=双 Esc 中止（不发送、输入回挂）。 */
export type VisionWaitResult = { state: "done"; text: string } | { state: "failed" } | { state: "aborted" };
/** 转述等待中止口（模块级单等待——等待期二次提交被发送闸拦；fullapp 双击 Esc 经 io 触发）。
 *  m5-split-main T4：可变单例随族私有化，main.ts 经 visionTranscribing/abortVisionTranscribe 访问器（D2）。 */
let visionWaitAbort: (() => void) | undefined;
export const visionTranscribing = (): boolean => visionWaitAbort !== undefined;
export const abortVisionTranscribe = (): void => { visionWaitAbort?.(); };

/** 转述等待（可中止）：服务缺席静默回落 failed；底层 describe 调用不掐——中止后结果照常落
 *  .summary.txt（重发命中缓存零等待——「中止不白等」），占位富化最终一致口径不变。
 *  onDelta（A 案 2026-10-02 拍板）：流式增量喂 DocModel 转述活动块（思考/正文流式显示防卡死感）。
 *  m5-split-main T4：自 main.ts 搬入，h 经参数注入（D2——内部走 h.graph() 服务读口）。 */
export const waitVisionTranscribe = async (imgs: string[], onDelta: ((d: { kind: "thinking" | "text"; text: string }) => void) | undefined, h: Harness): Promise<VisionWaitResult> => {
  const svc = await h.graph().services.getOptional("tool-media.vision-summary" as never).catch(() => undefined);
  const describe = (svc as { describe?: (images: { path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }[], onDelta?: (d: { kind: "thinking" | "text"; text: string }) => void) => Promise<{ path: string; text?: string }[]> } | undefined)?.describe;
  const aborted = new Promise<{ state: "aborted" }>((resolve) => { visionWaitAbort = () => resolve({ state: "aborted" }); });
  // live 旗（A 案泄漏口）：中止后底层调用不掐、增量还会来——迟到增量不得复活已清空的活动块
  let live = true;
  const feed = onDelta === undefined ? undefined : (d: { kind: "thinking" | "text"; text: string }) => { if (live) onDelta(d); };
  try {
    const raced: VisionWaitResult | undefined = describe === undefined
      ? undefined
      : await Promise.race([
          describe(imgs.map((path) => ({ path, mimeType: extImageMime(path) })), feed)
            .then((entries): VisionWaitResult => {
              const texts = entries.map((x) => x.text).filter((t): t is string => t !== undefined && t !== "");
              return texts.length > 0 ? { state: "done", text: texts.join("\n") } : { state: "failed" };
            })
            .catch((): VisionWaitResult => ({ state: "failed" })),
          aborted,
        ]);
    return raced ?? { state: "failed" };
  } finally {
    live = false;
    visionWaitAbort = undefined;
  }
};
