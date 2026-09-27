import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";

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
}

/** 读 [tool-subagent] 节两键（缺文件/缺节/缺键 = undefined——跟随态）。 */
export function readSubagentConfig(filePath = join(orosusHome(), "config.toml")): SubagentConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return {};
  }
  const sectionRe = /^\s*\[\s*([^\]#]+?)\s*\]/;
  const kvRe = /^\s*(model|approvalMode)\s*=\s*"([^"]*)"/;
  const out: SubagentConfig = {};
  let inSection = false;
  for (const line of raw.split(/\r?\n/)) {
    const sm = line.match(sectionRe);
    if (sm !== null) {
      inSection = sm[1] === "tool-subagent";
      continue;
    }
    if (!inSection) continue;
    const km = line.match(kvRe);
    if (km === null) continue;
    const v = km[2] ?? "";
    if (km[1] === "model" && v !== "") out.model = v;
    if (km[1] === "approvalMode" && (v === "auto" || v === "ask")) out.approvalMode = v;
  }
  return out;
}

/** 写/删 [tool-subagent] 节单键：value = null 删键（审批模式回「跟随」）；返回是否落到盘上。 */
export function writeSubagentConfigKey(key: "model" | "approvalMode", value: string | null, filePath = join(orosusHome(), "config.toml")): void {
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    /* 缺文件从空起 */
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.split(/\r?\n/);
  const sectionRe = /^\s*\[\s*([^\]#]+?)\s*\]/;
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  let inSection = false;
  let insertAt = -1;
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(sectionRe);
    if (m !== null) {
      if (inSection) { insertAt = i; break; }
      inSection = m[1] === "tool-subagent";
    } else if (inSection && keyRe.test(lines[i]!)) {
      if (value === null) {
        lines.splice(i, 1); // 删键 = 回跟随（缺省态）
        i--;
        removed = true;
      } else {
        lines[i] = `${key} = "${value}"`;
      }
      writeFileSync(filePath, lines.join(eol), "utf8");
      return;
    }
  }
  if (value === null) {
    if (removed) writeFileSync(filePath, lines.join(eol), "utf8"); // 已删（唯一键在节尾时此处收尾）
    return; // 键本就不在——无事可做
  }
  if (inSection && insertAt === -1) insertAt = lines.length; // 目标节是最后一节
  if (insertAt === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push("[tool-subagent]", `${key} = "${value}"`);
  } else {
    lines.splice(insertAt, 0, `${key} = "${value}"`);
  }
  writeFileSync(filePath, lines.join(eol), "utf8");
}

/** 审批模式菜单三档（决策 3/23 + m3b D8 中文名）：值 = null 表示「跟随主对话」（键缺席）。 */
export const APPROVAL_MENU: { value: SubagentApprovalMode | null; label: string; desc: string }[] = [
  { value: null, label: "跟随主对话", desc: "主对话从不询问 → 子代理也从不询问；否则需要时候询问（缺省）" },
  { value: "auto", label: "从不询问", desc: "子代理的工具调用照单放行、不弹窗（就算有问题也是模型自行判断）" },
  { value: "ask", label: "需要时候询问", desc: "走主对话关卡——规则链照常、危险操作弹窗询问" },
];

/** 审批模式设置流：三档菜单（当前值 ✓ 标注）→ 写/删键 → 返回人话结果（Esc = 已取消带内抛错由调用方静默）。 */
export async function runSubagentApprovalSetting(
  choose: (title: string, items: string[]) => Promise<string>,
  cfgFile: string,
): Promise<string> {
  const cur = readSubagentConfig(cfgFile).approvalMode ?? null;
  const items = APPROVAL_MENU.map((m) => `${m.label}——${m.desc}${m.value === cur ? " ✓" : ""}`);
  const picked = await choose("子代理 · 审批模式", items);
  const idx = items.indexOf(picked);
  const hit = APPROVAL_MENU[idx];
  if (hit === undefined) return "";
  writeSubagentConfigKey("approvalMode", hit.value, cfgFile);
  return hit.value === null
    ? "子代理审批模式：跟随主对话（配置键已清除）"
    : `子代理审批模式：${hit.label}（已写 [tool-subagent] approvalMode）`;
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
    return "暂无可选平台——先用 /provider 配置（子代理模型缺省跟父模型，不配置也能用）";
  }
  const slotName = withDefault.length === 1
    ? withDefault[0]!.name
    : (await choose("子代理模型 · 选择平台", withDefault.map((s) => s.name))).split("（")[0]!;
  const slot = slots.find((s) => s.name === slotName);
  if (slot === undefined) return "";
  const items = ["清除（跟工种声明 / 父模型）"];
  if (slot.listModels !== undefined) {
    try {
      items.push(...await slot.listModels());
    } catch { /* 清单拉取失败——只剩清除项与默认值 */ }
  }
  if (slot.defaultModel !== undefined && !items.includes(slot.defaultModel)) items.push(slot.defaultModel);
  const curBare = cur !== undefined && cur.includes("/") ? cur.split("/").pop() : cur;
  const picked = await choose(`子代理模型（${slotName}）`, items.map((m) => (m === curBare ? `${m} ✓` : m)));
  const final = picked.replace(/ ✓$/, "");
  if (final.startsWith("清除")) {
    writeSubagentConfigKey("model", null, cfgFile);
    return "子代理模型：已清除（跟工种声明 / 父模型）";
  }
  writeSubagentConfigKey("model", `${slotName}/${final}`, cfgFile);
  return `子代理模型：${slotName}/${final}（已写 [tool-subagent] model）`;
}
