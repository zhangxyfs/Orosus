/**
 * 持久协议串登记表（m5-i18n T4 / D13 拍板：独立文件导出常量 + 门禁白名单同源）。
 *
 * 这些字面量是**协议判据**（落盘回读/跨模块比对/正则匹配），翻译任一侧即破——门禁
 * i18n-no-raw-cjk 按本表值放行（出现处必须 import 常量，不许再写裸字面量）。
 * 清单主文件 §三（2026-10-06-m5-i18n-inventory.md）为完整账；本表只收 apps/cli 面，
 * core 侧协议串（SKILL_MARK／[非用户输入] 头族／日期系统行／压缩完成行）住在 core 各件、
 * D4 不翻边界护住，不在此登记。
 */

/** Esc 取消哨兵：picker/menu/skills-ui/settings-ui/tasks-cmd/hooks-ui/mcp-ui/repl-io 以 err.message === 全仓唯一比较。 */
export const ESC_CANCELLED = "已取消（Esc）";

/** 技能标记行前缀/尾段（D4 协议-不翻）：docmodel ● 行识别 + 防重入标记按精确形态匹配——版本化成本在案。 */
export const SKILL_MARK_PREFIX = "（用户通过菜单手动加载技能";
export const SKILL_MARK_TAIL = "——请按该技能正文行事）";

/** 门禁白名单值集（协议串本体——出现即放行；新协议串在此登记并注明判据面）。 */
export const PROTOCOL_STRINGS: readonly string[] = [ESC_CANCELLED, SKILL_MARK_PREFIX, SKILL_MARK_TAIL];
