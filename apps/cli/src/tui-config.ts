import { join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { loadConfig, writeSectionKey } from "@orosus/core";

/** [tui] sidebar 读写（F5 十二轮② 拍板：Ctrl+T 状态跨会话保留）。读 = 用户层优先、项目层兜底；写只落用户层。
 *  CM-01 修复（2026-09-28 code review P0）：① 读盘剥 BOM（v17 平台注记同源——Windows 工具常写 BOM，
 *  smol-toml 对带 BOM 文件 parse 必抛）；② 写侧「文件在但解析失败 → 拒绝写盘」——旧实现 catch 吞错后
 *  doc 从空起，writeFileSync(stringify) 整盘覆写只剩 [tui] 节，Ctrl+T 即静默毁掉用户全部配置（含
 *  provider/密钥引用）。宁可丢这一次持久化（会话内开关照常生效），不碰读不懂的盘。 */
export function tuiSidebarRead(userFile = join(orosusHome(), "config.toml"), projectFile = join(process.cwd(), ".orosus", "config.toml")): boolean {
	// m4-8 T2.5 收口 loadConfig（读配置单一事实源；modules.d/env 层自动生效）。
	// 分层对齐（方案空白 9）：旧散读「用户层优先」→ §6.6 权威「项目压用户」——tui 键几乎总在用户层，感知面近零。
	const v = (loadConfig({ userFile, projectFile }).sections.get("tui") as { sidebar?: unknown } | undefined)?.sidebar;
	return typeof v === "boolean" ? v : true;
}

export function tuiSidebarPersist(visible: boolean, userFile = join(orosusHome(), "config.toml")): void {
	// m4-8 T4 收口统一写口：行级节区感知写（CM-01 的 stringify 毁配置风险被行级写天然消除——
	// 行级写不 parse 整文件，坏 TOML 的其他行原样不动；[tui] 留守节 → 直写原文件）
	writeSectionKey(userFile, "tui", "sidebar", visible);
}
