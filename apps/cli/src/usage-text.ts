import { join, sep } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { deriveMessages } from "@orosus/core";
import type { Harness, SessionEvent } from "@orosus/core";
import { estimateTokens } from "@orosus/compaction";
import { formatBytes, dirUsage } from "./tuicfg.ts";
import { configFace } from "./config-face.ts";
import { realReadModel } from "./startup.ts";
import type { PanelData } from "./tui/fullapp.ts";
import { t } from "./i18n/app.ts";

/** 路径压缩（工作目录 KV——v1.11 三档：家目录 → ~ / 头+…+尾两级 / 只留尾两段）。
 *  m5-split-main T3：自 main.ts 搬入（纯函数零依赖）。 */
export const shortenPath = (p: string, maxW: number): string => {
	const home = orosusHome();
	let s2 = p;
	if (p === home || p.startsWith(home + "\\") || p.startsWith(home + "/")) s2 = "~" + p.slice(home.length);
	if (s2.length <= maxW) return s2;
	const parts = s2.split(/[\\/]/); // F5 走查实修：原 /[\/]/ 只劈正斜杠，Windows 路径整串落入「…\+全路径」
	// CM-16②（2026-09-28 code review）：两档模板此前硬编码 "\\"——POSIX 上压缩形把反斜杠混进正斜杠
	// 路径（面板 cwd 不可读）；join 与两处模板统一走 node:path 的 sep（Windows 输出逐字节不变）
	const tail = parts.slice(-2).join(sep);
	if (parts.length > 3) {
		const cand = parts[0] + sep + "…" + sep + tail; // 头+…+尾两段（F5 二轮：旧模板 \$ 把插值转义成字面量——rig 实证 C:…${tail}）
		if (cand.length <= maxW) return cand;
	}
	return "…" + sep + tail;
};

/** 末条 usage 输入/输出分拆（core jsonl.ts lastUsageTotal 同口径复制——/context 回退锚：末条即最近上下文规模）。
 *  F5 二轮⑤：面板 Tokens 行要 ↑ 输入 · ↓ 输出 分列，不再合并总量。
 *  v3 压缩后口径（2026-09-23 实机首例二：压缩成功但面板仍显示压缩前 73k——末条 usage 停在压缩前的请求，
 *  数字回落被滞后掩盖到下一条消息）：末条 turn/compaction 晚于末条 usage 时，input 换压缩后投影估算
 *  （deriveMessages 已应用压缩事件）并置 postCompaction 标记。 */
export const lastUsageOf = (events: SessionEvent[]): { input: number; output: number; postCompaction?: boolean } => {
  let usageSeq = -1;
  let result = { input: 0, output: 0 };
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "assistant/chunk") {
      const c = e.chunk as { type?: string; input?: number; output?: number } | undefined;
      if (c?.type === "usage") { result = { input: c.input ?? 0, output: c.output ?? 0 }; usageSeq = e.seq; break; }
    }
    if (e.type === "assistant/message") {
      const u = e.usage as { input?: number; output?: number } | undefined;
      if (u !== undefined) { result = { input: u.input ?? 0, output: u.output ?? 0 }; usageSeq = e.seq; break; }
    }
  }
  const lastCompaction = events.filter((e) => e.type === "turn/compaction").at(-1) as { seq?: number } | undefined;
  if (lastCompaction !== undefined && (lastCompaction.seq ?? 0) > usageSeq) {
    return { input: estimateTokens(deriveMessages(events)), output: result.output, postCompaction: true };
  }
  return result;
};

/** tokens 就地刷新（2026-10-04 用户拍板「token/上下文有变化就得更新」）：assistant/message（usage
 *  落定）与 turn/compaction（input 换压缩后投影估算）两事件到达时重算末条 usage 投影就地写回面板
 *  快照——此前只有 refreshPanel（turn 结束/命令提交/插拔）重算，turn 进行中（agent 一轮可跑十分钟）
 *  Tokens 行与上下文条停在旧值（新会话首 turn 恒 0/0）。cache 未就绪（首刷前）返 undefined 跳过。 */
export const withLiveTokens = (cache: PanelData | undefined, events: SessionEvent[]): PanelData | undefined =>
  cache === undefined ? undefined : { ...cache, tokens: lastUsageOf(events) };

/** 末次模型请求耗时（2026-10-01 拍板 B——被动真值，loop 随 assistant/message 落 durationMs）：
 *  倒扫最近一条带 durationMs 的 assistant/message；老会话（字段未生年代）= undefined 不显示。 */
export const lastRequestMsOf = (events: SessionEvent[]): number | undefined => {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i]!;
		if (e.type === "assistant/message" && typeof e.durationMs === "number") return e.durationMs;
	}
	return undefined;
};

/** 磁盘占用视图文本（F6——ROADMAP 缓存目录条目③销账面）。 */
export const diskUsageText = (): string => {
	const home = orosusHome();
	const names = ["cache", "sessions", "logs", "tmp", "modules"];
	const lines: string[] = [];
	let total = 0;
	let totalFiles = 0;
	for (const name of names) {
		const u = dirUsage(join(home, name));
		total += u.bytes;
		totalFiles += u.files;
		lines.push(`${name.padEnd(10)}${formatBytes(u.bytes).padStart(10)}   ${t("usage.disk.files", { n: u.files })}`);
	}
	lines.push("");
	lines.push(`${t("usage.disk.total").padEnd(10)}${formatBytes(total).padStart(10)}   ${t("usage.disk.files", { n: totalFiles })}`);
	lines.push("");
	lines.push(t("usage.disk.root", { home }));
	lines.push(t("usage.disk.cleanup"));
	return lines.join("\n");
};

/** 上下文用量视图文本（F5 十六轮③：/context 并入——panelCache 同源数据）。
 *  m5-split-main T3：自 main.ts 搬入，panelCache 经参数注入（D2——本体在 modules 侧 T9 归位）。 */
export const ctxUsageText = (p: PanelData | undefined): string => {
	const cfg = configFace();
	const model = (() => {
		const v = realReadModel(process.cwd())() ?? "";
		if (v === "") return t("panel.unconfigured");
		// CT-02（2026-09-28 code review）：首斜杠切分取模型段——嵌套模型 id（目录侧 openrouter 族真实产出
		// 如 openai/gpt-4o）旧 split("/").pop() 只剩尾段丢前缀；与 contracts 新口径一致（首个 "/" 前 =
		// 提供商名、其余整体 = 模型 id）
		const slash = v.indexOf("/");
		return slash >= 0 ? v.slice(slash + 1) : v;
	})();
	const used = p?.tokens.input ?? 0;
	const pct = cfg.contextWindow > 0 ? Math.min(100, Math.round((used / cfg.contextWindow) * 100)) : 0;
	return [
		t("settings.title.ctx"),
		"",
		t("usage.ctx.model", { model }),
		t("usage.ctx.window", { n: cfg.contextWindow.toLocaleString() }),
		t("usage.ctx.used", { n: used.toLocaleString(), pct, postCompaction: p?.tokens.postCompaction === true ? "1" : undefined }),
		t("usage.ctx.input", { n: (p?.tokens.input ?? 0).toLocaleString() }),
		t("usage.ctx.output", { n: (p?.tokens.output ?? 0).toLocaleString() }),
		"",
		t("usage.ctx.note"),
	].join("\n");
};

/** m5-split-main T3：自 main.ts 搬入，h 经参数注入（D2——内部走 h.usage() 读口）。 */
export const tokenUsageText = async (h: Harness): Promise<string> => {
	try {
		const u = await h.usage();
		const lines = [t("usage.tokens.current", { i: u.current.input, o: u.current.output })];
		if (u.lifetime !== undefined) lines.push(t("usage.tokens.lifetime", { n: u.lifetime.sessions, i: u.lifetime.input, o: u.lifetime.output }));
		return lines.join("\n");
	} catch (err) {
		return t("usage.tokens.error", { err: err instanceof Error ? err.message : String(err) });
	}
};

/** m5-split-main T3：自 main.ts 搬入，h 经参数注入（D2——内部走 h.status() 读口）。 */
export const runtimeStatusText = (h: Harness): string => {
	const st = h.status();
	return [
		`model: ${st.model}${st.overridden ? t("usage.runtime.override") : ""}`,
		...(st.effort !== undefined ? [`effort: ${st.effort}`] : []), // /effort 已设才显示（2026-09-25）
		`session: ${st.sessionId}`,
		t("usage.runtime.modules", { a: st.modules.active, f: st.modules.failed, d: st.modules.discovered }),
	].join("\n");
};
