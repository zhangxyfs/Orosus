import { join, dirname } from "node:path";
import { loadConfig, writeSectionKey, sectionPath } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";
import { t } from "./i18n/app.ts";

/**
 * 子代理设置（M4.5 T12 / 决策 7/23）：/settings →「子代理」分组 →「子代理模型」「审批模式」两子项。
 * 存 [tool-subagent] 节两键（model / approvalMode；缺省 = 跟随——键不在场即跟随）。
 * 行级节区感知写（module-toggle.ts 同款纪律：不洗注释与键序、保行尾风格、节尾/文件尾插入、缺键删除 = 跟随）。
 */

/** 审批模式配置值：auto = 从不询问（照单放行）、ask = 需要时候询问（转主关卡）；键缺席 = 跟随主对话。 */
export type SubagentApprovalMode = "auto" | "ask";

export interface SubagentConfig {
  model?: string;
  approvalMode?: SubagentApprovalMode;
  maxTurns?: number; // -1 = 不限（仅时长兜底）；1-200；缺省 = 默认 100
}

/** 读 [tool-subagent] 节两键（缺文件/缺节/缺键 = undefined——跟随态）。 */
export function readSubagentConfig(filePath = join(orosusHome(), "config.toml")): SubagentConfig {
  // m4-8 T4 收口 loadConfig（读配置单一事实源；转义还原交 smol-toml——CM-11 手写 unescape 退役；
  // modules.d 新家同读——路由后的 tool-subagent.toml 自动可见）
  const sec = (loadConfig({ userFile: filePath, userModulesDir: join(dirname(filePath), "modules.d") }).sections.get("tool-subagent") ?? {}) as {
    model?: unknown; approvalMode?: unknown; maxTurns?: unknown;
  };
  const out: SubagentConfig = {};
  if (typeof sec.model === "string" && sec.model !== "") out.model = sec.model;
  if (sec.approvalMode === "auto" || sec.approvalMode === "ask") out.approvalMode = sec.approvalMode;
  if (typeof sec.maxTurns === "number" && Number.isInteger(sec.maxTurns)) out.maxTurns = sec.maxTurns;
  return out;
}

/** 写/删 [tool-subagent] 节单键：value = null 删键（审批模式回「跟随」）；返回是否落到盘上。 */
export function writeSubagentConfigKey(key: "model" | "approvalMode" | "maxTurns", value: string | null, filePath = join(orosusHome(), "config.toml")): void {
  // m4-8 T4 收口统一写口（行级逻辑活在 core/config/write.ts）；CM-11 值域前置与转义由写口承担。
  // maxTurns 数值裸、字符串带引号——经 Number/类型自然分派
  if (key === "maxTurns" && value !== null && !/^(-1|[1-9]\d*)$/.test(value)) {
    throw new Error(`${t("subagent.maxTurns.invalid", { value: value })}`);
  }
  // 路由内建（m4-8 T4）：模块节落 modules.d/tool-subagent.toml（目录/文件 sectionPath 建；留守节不会到这）
  const target = sectionPath("tool-subagent", { userConfig: filePath, modulesDir: join(dirname(filePath), "modules.d"), isModule: () => true });
  writeSectionKey(target, "tool-subagent", key, value === null ? null : key === "maxTurns" ? Number(value) : value);
}

/** 审批模式菜单三档（决策 3/23 + m3b D8 中文名）：值 = null 表示「跟随主对话」（键缺席）。 */
export const approvalMenu = (): { value: SubagentApprovalMode | null; label: string; desc: string }[] => [
  { value: null, label: t("subagent.approval.follow"), desc: t("subagent.approval.follow") },
  { value: "auto", label: t("perm.never"), desc: t("subagent.approval.auto") },
  { value: "ask", label: t("perm.askRisky"), desc: t("subagent.approval.ask") },
];

/** 审批模式设置流：三档菜单（当前值 ✓ 标注）→ 写/删键 → 返回人话结果（Esc = 已取消带内抛错由调用方静默）。 */
export async function runSubagentApprovalSetting(
  choose: (title: string, items: string[]) => Promise<string>,
  cfgFile: string,
): Promise<string> {
  const cur = readSubagentConfig(cfgFile).approvalMode ?? null;
  const items = approvalMenu().map((m) => `${m.label}——${m.desc}${m.value === cur ? " ✓" : ""}`);
  const picked = await choose(t("subagent.approval.title"), items);
  const idx = items.indexOf(picked);
  const hit = approvalMenu()[idx];
  if (hit === undefined) return "";
  writeSubagentConfigKey("approvalMode", hit.value, cfgFile);
  return hit.value === null
    ? t("subagent.approval.cleared")
    : t("subagent.approval.written", { label: hit.label });
}

/** 子代理模型设置流（决策 7：复用 /model 菜单组件换数据源——同款两段选：平台 → 模型；当前值 ✓）。
 *  providers 槽清单由调用方喂（h.graph().services）；「清除」项 = 回工种/父模型（删键）。 */
export async function runSubagentModelSetting(
  choose: (title: string, items: string[]) => Promise<string>,
  cfgFile: string,
  slots: { name: string; defaultModel?: string; listModels?: () => Promise<string[]> }[],
): Promise<string> {
  const cur = readSubagentConfig(cfgFile).model;
  const withDefault = slots.filter((s) => s.defaultModel !== undefined);
  if (withDefault.length === 0) {
    return t("subagent.model.noSlots");
  }
  const slotName = withDefault.length === 1
    ? withDefault[0]!.name
    : (await choose(t("subagent.model.pickSlot"), withDefault.map((s) => s.name))).split("（")[0]!;
  const slot = slots.find((s) => s.name === slotName);
  if (slot === undefined) return "";
  const items = [t("subagent.model.clear")];
  if (slot.listModels !== undefined) {
    try {
      items.push(...await slot.listModels());
    } catch { /* 清单拉取失败——只剩清除项与默认值 */ }
  }
  if (slot.defaultModel !== undefined && !items.includes(slot.defaultModel)) items.push(slot.defaultModel);
  const curBare = cur !== undefined && cur.includes("/") ? cur.split("/").pop() : cur;
  const picked = await choose(t("subagent.model.pickModel", { slot: slotName }), items.map((m) => (m === curBare ? `${m} ✓` : m)));
  const final = picked.replace(/ ✓$/, "");
  if (final.startsWith(t("subagent.model.clear"))) {
    writeSubagentConfigKey("model", null, cfgFile);
    return t("subagent.model.cleared");
  }
  writeSubagentConfigKey("model", `${slotName}/${final}`, cfgFile);
  return t("subagent.model.written", { model: `${slotName}/${final}` });
}

/** 轮数上限设置流（双保险丝批 2026-09-27）：菜单 = 跟随默认/150/200/不限（-1，仅时长兜底）/自定义 1-200；
 *  当前值 ✓ 标注；「跟随默认」= 删键（内核默认 100）。 */
export async function runSubagentMaxTurnsSetting(
  choose: (title: string, items: string[]) => Promise<string>,
  ask: (title: string) => Promise<string>,
  cfgFile: string,
): Promise<string> {
  const cur = readSubagentConfig(cfgFile).maxTurns;
  const PRESETS = (): { v: number | null; label: string; desc: string }[] => [
    { v: null, label: t("subagent.turns.follow"), desc: t("subagent.turns.follow.desc") },
    { v: 150, label: "150", desc: t("subagent.turns.150") },
    { v: 200, label: "200", desc: t("subagent.turns.200") },
    { v: -1, label: t("subagent.turns.unlimited"), desc: t("subagent.turns.unlimited.desc") },
  ];
  const presets = PRESETS();
  const items = [...presets.map((p) => `${p.label}——${p.desc}${p.v === cur ? " ✓" : ""}`), t("subagent.turns.custom")];
  const picked = await choose(t("subagent.turns.title"), items);
  if (items.indexOf(picked) < 0) return "";
  if (picked.startsWith(t("subagent.turns.custom"))) {
    const raw = (await ask(t("subagent.turns.askCustom"))).trim();
    if (!/^(-1|[1-9]\d*)$/.test(raw) || (Number(raw) !== -1 && (Number(raw) < 1 || Number(raw) > 200))) {
      return `${t("subagent.turns.invalid", { raw: raw })}`;
    }
    writeSubagentConfigKey("maxTurns", raw, cfgFile);
    return t("subagent.turns.setCustom", { raw });
  }
  const hit = presets[items.indexOf(picked)];
  if (hit === undefined) return "";
  writeSubagentConfigKey("maxTurns", hit.v === null ? null : String(hit.v), cfgFile);
  return hit.v === null
    ? t("subagent.turns.cleared")
    : t("subagent.turns.setPreset", { label: hit.label, v: hit.v === -1 ? undefined : hit.v, timeOnly: hit.v === -1 ? "1" : undefined });
}
