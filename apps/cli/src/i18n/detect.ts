/**
 * m5-i18n T2：启动系统语言检测（P2）——pickFromSignals 纯函数（信号注入可矩阵测试）。
 *
 * 平台分派：
 * - win32：ICU 真值优先于 env（Node 的 ICU 默认 locale 反映 OS 用户区域、不受 Git Bash LANG=en_US 噪音
 *   影响——「OS 真值优先于 env」）；刻意 env 英文者 /locale 一次即好。
 * - linux：env 四级 LC_ALL > LC_MESSAGES > LANG > LC_CTYPE（C/POSIX 视为未设）。
 * - darwin：env 四级先，皆无则 defaults read -g AppleLocale 兜底（仅此分支 execSync——由采集器做）。
 * 检测 = 每次启动的临时缺省，不写 config；中文 Hans/Hant 分族落简/繁、其余 en-US。
 */

import { execSync } from "node:child_process";

import { normalizeLocaleTag } from "@orosus/i18n";

export interface LocaleSignals {
	platform: string;
	/** env 四级值（LC_ALL, LC_MESSAGES, LANG, LC_CTYPE 顺序由采集器保证）。 */
	envChain?: (string | undefined)[];
	/** win32：Intl resolvedOptions().locale（ICU / OS 真值）。 */
	icuLocale?: string;
	/** darwin：defaults read -g AppleLocale 的值（execSync 由采集器做、失败为 undefined）。 */
	appleLocale?: string | undefined;
}

/** zh 族信号 → 简/繁分族映射；非 zh → en-US（P2 检测只产三内置值）。 */
function mapSignal(raw: string): "zh-CN" | "zh-TW" | "en-US" | undefined {
	const tag = normalizeLocaleTag(raw);
	if (tag === "zh-CN" || tag === "zh-TW") return tag;
	if (tag.startsWith("zh")) return "zh-CN"; // 归一未尽族（防御）——zh 视为简体
	return "en-US";
}

function firstUsefulEnv(chain: (string | undefined)[]): string | undefined {
	for (const v of chain) {
		if (v === undefined || v === "") continue;
		const t = v.trim();
		if (t === "" || t === "C" || t === "C.UTF-8" || t === "POSIX") continue; // C/POSIX 视为未设
		return t;
	}
	return undefined;
}

export function pickFromSignals(s: LocaleSignals): "zh-CN" | "zh-TW" | "en-US" {
	if (s.platform === "win32") {
		// ICU 真值优先于 env——刻意透传 env 进来也不看（噪音免疫）；无 ICU 值才看 env 兜底
		if (s.icuLocale !== undefined && s.icuLocale !== "") return mapSignal(s.icuLocale) ?? "en-US";
		const env = firstUsefulEnv(s.envChain ?? []);
		return env !== undefined ? (mapSignal(env) ?? "en-US") : "en-US";
	}
	const env = firstUsefulEnv(s.envChain ?? []);
	if (env !== undefined) return mapSignal(env) ?? "en-US";
	if (s.platform === "darwin" && s.appleLocale !== undefined && s.appleLocale !== "") {
		return mapSignal(s.appleLocale) ?? "en-US";
	}
	return "en-US";
}

/** 采集器：读真实环境构信号（execSync 只在 darwin 且 env 全空时调用）。 */
export function collectLocaleSignals(): LocaleSignals {
	const envChain = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, process.env.LC_CTYPE];
	const signals: LocaleSignals = {
		platform: process.platform,
		envChain,
		icuLocale: new Intl.DateTimeFormat().resolvedOptions().locale,
	};
	if (process.platform === "darwin" && firstUsefulEnv(envChain) === undefined) {
		try {
			signals.appleLocale = execSync("defaults read -g AppleLocale", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			signals.appleLocale = undefined;
		}
	}
	return signals;
}

export function detectSystemLocale(): "zh-CN" | "zh-TW" | "en-US" {
	return pickFromSignals(collectLocaleSignals());
}
