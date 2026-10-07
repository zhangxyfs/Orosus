/** m5-update-check T5：「更新检查」开关——[update] check 键（留守节住 config.toml；缺省开）。
 *  只管自动检测（D4）：关 = 不点火不联网、横幅行不渲染；orosus upgrade 手动口不受影响。
 *  写 = writeSectionKey 行级节区感知（tui-config.ts [tui] sidebar 同款——不洗注释与键序）；
 *  读 = loadConfig 单一事实源（main 接线带项目层 §6.6 项目压用户；设置流展示读用户层）。 */
import { join } from "node:path";
import { loadConfig, writeSectionKey } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";
import { t } from "./i18n/app.ts";

export const updateConfigFile = (): string => join(orosusHome(), "config.toml");

export function readUpdateCheckEnabled(userFile = updateConfigFile(), projectFile?: string): boolean {
	const v = (loadConfig(projectFile !== undefined ? { userFile, projectFile } : { userFile }).sections.get("update") as { check?: unknown } | undefined)?.check;
	return typeof v === "boolean" ? v : true;
}

export function writeUpdateCheckKey(enabled: boolean, userFile = updateConfigFile()): void {
	writeSectionKey(userFile, "update", "check", enabled);
}

/** 设置流（runSubagentApprovalSetting 同款）：两档菜单当前值 ✓ → 写键 → 人话回执（未匹配 = 空串静默）。 */
export async function runUpdateCheckSetting(choose: (title: string, items: string[]) => Promise<string>, cfgFile: string): Promise<string> {
	const cur = readUpdateCheckEnabled(cfgFile);
	const options = [t("update.setting.on"), t("update.setting.off")];
	const items = options.map((l, i) => (i === (cur ? 0 : 1) ? `${l} ✓` : l));
	const picked = await choose(t("settings.items.update"), items);
	const idx = items.indexOf(picked);
	if (idx !== 0 && idx !== 1) return "";
	writeUpdateCheckKey(idx === 0, cfgFile);
	return idx === 0 ? t("update.setting.writtenOn") : t("update.setting.writtenOff");
}
