/**
 * m5-i18n T4：宿主 t 单例——tui 渲染文件的翻译口（每帧热路径，只读 store 预构建合并表）。
 *
 * 缺省 = zh-CN 界面主目录 + 地板（store 就绪前的启动窗口、以及 tui 单测不装配 store 时——
 * 存量断言 zh 输出的测试零改动保持绿）；main.ts 在 store init 后调 bindAppLocale 换活实现。
 * 测试侧 bindTestLocale(tag) 可切三语做断言。
 */

import { createT, floorCatalogs, type TFunction } from "@orosus/i18n";

import { mainTables } from "../locales/index.ts";

const builtinTables = (): Record<string, Record<string, string>> => {
	const main = mainTables();
	const out: Record<string, Record<string, string>> = {};
	for (const tag of ["zh-CN", "zh-TW", "en-US"]) out[tag] = { ...floorCatalogs[tag], ...main[tag] };
	return out;
};

let impl: TFunction = createT({ tag: "zh-CN", getTable: (tag) => builtinTables()[tag] });

/** 宿主 store 就绪后换活实现（图槽/语言包/catalog 段参与解析）。 */
export const bindAppLocale = (t: TFunction): void => {
	impl = t;
};

/** 测试侧：切三语（直读内置表——不依赖图）。 */
export const bindTestLocale = (tag: string): void => {
	impl = createT({ tag, getTable: (x) => builtinTables()[x] });
};

export const t: TFunction = (key, params, fallback) => impl(key, params, fallback);
