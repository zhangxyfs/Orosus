/**
 * m5-i18n 界面主目录装配（T4 起步）：按域分文件、三语同构平行（parity 测试锁键集一致）。
 * 值的事实源 = 本目录；五语对照表（specs/i18n-translations/）为作者期基准——漂移以先落盘者为准并记批台账。
 * core.* 键不在此（住 @orosus/i18n 地板）；ja/ko/ru 全键表住 multilang 语言包（槽优先覆盖）。
 */
import type { Messages } from "@orosus/i18n";

import { zhCNInput } from "./zh-CN/input.ts";
import { zhCNPanels } from "./zh-CN/panels.ts";
import { zhTWInput } from "./zh-TW/input.ts";
import { zhTWPanels } from "./zh-TW/panels.ts";
import { enUSInput } from "./en-US/input.ts";
import { enUSPanels } from "./en-US/panels.ts";

export const mainTables = (): Record<string, Messages> => ({
	"zh-CN": { ...zhCNInput, ...zhCNPanels },
	"zh-TW": { ...zhTWInput, ...zhTWPanels },
	"en-US": { ...enUSInput, ...enUSPanels },
});
