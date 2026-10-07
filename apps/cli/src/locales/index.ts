/**
 * m5-i18n 界面主目录装配（T4 起步）：按域分文件、三语同构平行（parity 测试锁键集一致）。
 * 值的事实源 = 本目录；五语对照表（specs/i18n-translations/）为作者期基准——漂移以先落盘者为准并记批台账。
 * core.* 键不在此（住 @orosus/i18n 地板）；ja/ko/ru 全键表住 multilang 语言包（槽优先覆盖）。
 */
import type { Messages } from "@orosus/i18n";

import { zhCNInput } from "./zh-CN/input.ts";
import { zhCNPanels } from "./zh-CN/panels.ts";
import { zhCNMcp } from "./zh-CN/mcp.ts";
import { zhCNMenus } from "./zh-CN/menus.ts";
import { zhCNNotices } from "./zh-CN/notices.ts";
import { zhTWInput } from "./zh-TW/input.ts";
import { zhTWPanels } from "./zh-TW/panels.ts";
import { zhTWMcp } from "./zh-TW/mcp.ts";
import { zhTWMenus } from "./zh-TW/menus.ts";
import { zhTWNotices } from "./zh-TW/notices.ts";
import { enUSInput } from "./en-US/input.ts";
import { enUSPanels } from "./en-US/panels.ts";
import { enUSMcp } from "./en-US/mcp.ts";
import { enUSMenus } from "./en-US/menus.ts";
import { enUSNotices } from "./en-US/notices.ts";

export const mainTables = (): Record<string, Messages> => ({
	"zh-CN": { ...zhCNInput, ...zhCNPanels, ...zhCNMcp, ...zhCNMenus, ...zhCNNotices },
	"zh-TW": { ...zhTWInput, ...zhTWPanels, ...zhTWMcp, ...zhTWMenus, ...zhTWNotices },
	"en-US": { ...enUSInput, ...enUSPanels, ...enUSMcp, ...enUSMenus, ...enUSNotices },
});
