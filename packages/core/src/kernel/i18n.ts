/**
 * 内核地板 t（m5-i18n T1）——core 自渲染面的 failReason 族走三语地板目录（@orosus/i18n）。
 *
 * 口径（方案 §5.2 / D5）：语言切换只影响新事件——failReason 在事件发生时以当时语言落账，
 * 旧记录保持原语言；宿主启动时按 config.language（或系统检测）调 setKernelLocale 对齐。
 * 地板只有简/繁/英三语：语言包语种（ja/ko/ru）下 core 自渲染面落英文（P1 降级锚 = en）。
 */

import { createFloorT, normalizeLocaleTag, type TFunction } from "@orosus/i18n";

let current: TFunction = createFloorT("zh-CN");

export function setKernelLocale(raw: string | undefined): void {
	// undefined = 复位缺省 zh-CN（宿主注入前/测试隔离）；有值才归一（归一空串会落 en-US——语义不同）
	current = raw === undefined || raw === "" ? createFloorT("zh-CN") : createFloorT(normalizeLocaleTag(raw));
}

/** core 内 failReason / 自渲染文案统一出口（键见 packages/i18n/src/floor.ts）。 */
export const kernelT: TFunction = (key, params, fallback) => current(key, params, fallback);
