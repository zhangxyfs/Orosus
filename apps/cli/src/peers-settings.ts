import { join, dirname } from "node:path";
import { loadConfig, writeSectionKey, sectionPath } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";
import * as theme from "./theme.ts";

/**
 * 会话互相感知设置面（m5-peers T6b，v2 走查定案）：/settings →「记忆」动态项（tool-peers 启用时出现）
 *  → 工作区记忆 / 会话感知 双开关。存 [tool-peers] 节两键（缺键 = 关，D13）；写键后 reloadModulesIdle 生效（D15）。
 *  行级节区感知写（subagent-settings.ts 同款纪律）。开关切换 = 回车即切，✓ 标当前值。
 */

export interface PeersToggleConfig { workspaceMemory: boolean; sessionPeers: boolean }

/** 读 [tool-peers] 门控两键（缺文件/缺节/缺键 = 关——「缺键 = 关」与子代理「缺键 = 跟随」同族语义）。 */
export function readPeersConfig(filePath = join(orosusHome(), "config.toml")): PeersToggleConfig {
  const sec = (loadConfig({ userFile: filePath, userModulesDir: join(dirname(filePath), "modules.d") }).sections.get("tool-peers") ?? {}) as {
    workspaceMemory?: unknown; sessionPeers?: unknown;
  };
  return { workspaceMemory: sec.workspaceMemory === true, sessionPeers: sec.sessionPeers === true };
}

/** 写 [tool-peers] 节单键（布尔裸值）；路由内建 → modules.d/tool-peers.toml（m4-8 惯例）。 */
export function writePeersConfigKey(key: "workspaceMemory" | "sessionPeers", value: boolean, filePath = join(orosusHome(), "config.toml")): void {
  const target = sectionPath("tool-peers", { userConfig: filePath, modulesDir: join(dirname(filePath), "modules.d"), isModule: () => true });
  writeSectionKey(target, "tool-peers", key, value);
}

/** 「记忆」子菜单三项流（T6b 双开关 + 走查修订三「记忆导入」）：回车即切换并写键 / 进导入流；
 *  返回 { kind: "toggle", ... }（写盘已发生，reload 由调用方收尾）或 { kind: "import" }（调用方走
 *  runMemoryImportSetting）。undefined = Esc/未匹配（回上一级）。文案带 token 消耗提示（v2 走查定案）。
 *  浏览窗不开设置入口（走查修订二：入口 = /tool-peers__memory 命令 + Ctrl+P 总览）。 */
export type MemorySettingResult =
  | { kind: "toggle"; key: "workspaceMemory" | "sessionPeers"; value: boolean; message: string }
  | { kind: "import" };

export async function runMemorySetting(
  choose: (title: string, items: string[]) => Promise<string>,
  cfgFile: string = join(orosusHome(), "config.toml"),
): Promise<MemorySettingResult | undefined> {
  const cfg = readPeersConfig(cfgFile);
  const items = [
    `工作区记忆 —— ${cfg.workspaceMemory ? "开 ✓" : "关"}（共享笔记 + 索引注入：本会话写、其他会话读；开启后系统提示带记忆索引，有 token 消耗）`,
    `会话感知 —— ${cfg.sessionPeers ? "开 ✓" : "关"}（查同伴 / 文件占用：peers 查询对每个活会话按需做一句话总结，有 token 消耗）`,
    "记忆导入（从 Claude Code / ZCode / qwen / codex / Reasonix 搬入既有记忆——不耗 token）",
  ];
  const picked = await choose("记忆", items);
  const idx = items.indexOf(picked);
  if (idx === 2) return { kind: "import" };
  if (idx !== 0 && idx !== 1) return undefined;
  const key: "workspaceMemory" | "sessionPeers" = idx === 0 ? "workspaceMemory" : "sessionPeers";
  const value = !(idx === 0 ? cfg.workspaceMemory : cfg.sessionPeers);
  writePeersConfigKey(key, value, cfgFile);
  const label = idx === 0 ? "工作区记忆" : "会话感知";
  return { kind: "toggle", key, value, message: `${label}：${value ? "开" : "关"}（已写 [tool-peers] ${key}）` };
}

/** D10/D11 导入范围：current = 仅当前项目；all = 全部项目各归各桶（镜像）。 */
export type ImportScope = "current" | "all";

/** 记忆导入数据口（走查修订三 + 走查八：settings 侧 = 引导第 5 页同功能——含 D20 模型整理〔逐条
 *  内容优化 + 重写 description，走查八-③ 重定义〕与进度回调）。宿主接线复用 importers 件 + h.llm()。
 *  m5-peers-import-fix T6：detect 增 newCount（D7 已导计数）/global（codex 全局源标注）；run 增 mode
 *  （D10/D11 导入范围——current = 仅当前项目、all = 全部项目各归各桶〔镜像〕）。 */
export interface MemoryImportSourceInfo { id: string; label: string; count: number; newCount?: number; global?: boolean }
export interface MemoryImportResult { imported: number; updated?: number; skipped: number; merged: number; mirror?: { projects: number; unresolved: number } }

export interface MemoryImportDeps {
  /** 五源探测（有货才列：count > 0）；destDir 给出时每源带 newCount（0 = 已全部导入）。 */
  detect(): MemoryImportSourceInfo[];
  /** 执行导入（organize = true 逐条模型整理——内容优化 + 重写摘要 + 改英文短题；onProgress **前置**
   *  每条一步；signal = Alt+C 强停〔走查十二-④〕——硬中断：剩余条目不拷不落盘；mode = "all" 时四家
   *  走镜像各归各桶、codex 仍导当前桶〔结果 mirror 字段在场〕）。 */
  run(sourceIds: string[], organize: boolean, mode: ImportScope, onProgress?: (done: number, total: number, title: string) => void, signal?: AbortSignal): Promise<MemoryImportResult>;
}

/** 「记忆导入」选择段（走查八-④：整理是**开关**项——开启后不论全部导入还是单源导入都走整理）：
 *  菜单 = 每源一项 + 全部导入 + 导入范围模式行 + 「用模型整理」开关行（回车/空格切换，当次会话态不落盘）。
 *  m5-peers-import-fix T6：模式行默认 current（D11 settings 增量补给心智）；源行带（新 M）（G4），
 *  current 模式下 M=0 显示「已全部导入」且选拦（D7）；global 源行尾缀标注（G2）；全部导入合计 =
 *  sum(newCount)。
 *  返回 { ids, organize, mode }（执行段由调用方跑——全屏接进度弹窗）；"empty" = 无货源；undefined = Esc。 */
export async function runMemoryImportChoose(
  choose: (title: string, items: string[]) => Promise<string>,
  deps: MemoryImportDeps,
  initialOrganize = false,
): Promise<{ ids: string[]; organize: boolean; mode: ImportScope } | "empty" | undefined> {
  const sources = deps.detect().filter(s => s.count > 0);
  if (sources.length === 0) return "empty";
  const totalNew = sources.reduce((n, s) => n + (s.newCount ?? s.count), 0);
  const organizeRow = (on: boolean): string => `用模型整理 —— ${on ? "开 ✓" : "关"}（逐条优化内容 + 重写摘要 + 英文短题，消耗 token 一次性；开启后所有导入路径都走整理）`;
  // G10 模式行（2026-10-08 用户走查修）：标签「导入范围」恒白、**当前值（连 ✓）accent 绿**、另一选项白
  const scopeRow = (mode: ImportScope): string => {
    const cur = mode === "current" ? theme.fg("accent", "仅当前项目 ✓") : theme.fg("fg", "仅当前项目");
    const all = mode === "all" ? theme.fg("accent", "全部项目（各归各桶）✓") : theme.fg("fg", "全部项目（各归各桶）");
    return `${theme.fg("fg", "导入范围 —— ")}${cur}${theme.fg("fg", " / ")}${all}`;
  };
  const globalNote = "（全局源——不分项目，含所有项目的笔记）";
  const sourceRow = (s: MemoryImportSourceInfo): string => {
    // 2026-10-08 覆盖拍板：D7「已全部导入」拦勾退役——重导 = 覆盖更新，M=0 也是有效操作；
    // （新 M）仍按当前项目桶差集计（镜像模式下该源其他项目的量不由此数表达，仅供参考）
    const fresh = s.newCount === undefined ? "" : `（新 ${s.newCount}）`;
    return `${s.label} —— 导入该源 ${s.count} 条${fresh}${s.global === true ? globalNote : ""}`;
  };
  let organize = initialOrganize;
  let mode: ImportScope = "current";
  for (;;) {
    const items = [
      ...sources.map(s => sourceRow(s)),
      `全部导入 —— ${sources.length} 家共 ${totalNew} 条`,
      scopeRow(mode),
      organizeRow(organize),
    ];
    // 2026-10-08 覆盖拍板：菜单标题即「提示」——重复导入将覆盖同标题旧版（结果文案另报覆盖数）
    const picked = await choose("记忆 · 导入（重复导入将覆盖同标题旧版）", items);
    const idx = items.indexOf(picked);
    if (idx === -1) return undefined;   // Esc
    if (idx === items.length - 1) { organize = !organize; continue; }   // 整理开关行：切换后菜单刷新（✓ 移位）
    if (idx === items.length - 2) { mode = mode === "current" ? "all" : "current"; continue; }   // 模式行（G10）
    if (idx < sources.length) return { ids: [sources[idx]!.id], organize, mode };
    return { ids: sources.map(s => s.id), organize, mode };   // 覆盖语义：全部导入含 M=0 源（重导即覆盖）
  }
}

/** 导入结果人话（执行段完成后的 toast/out 文案）。覆盖语义（2026-10-08 拍板）：updated 段单独报——
 *  「更新覆盖 N 条旧版」即提示；skipped 只剩源内同名互撞（罕见）。 */
export const memoryImportResultText = (r: { imported: number; updated?: number; skipped: number; merged: number }): string => {
  const u = r.updated ?? 0;
  const seg = [
    ...(u > 0 ? [`更新覆盖 ${u} 条旧版`] : []),
    ...(r.skipped > 0 ? [`源内同名跳过 ${r.skipped} 条`] : []),
  ].join(" · ");
  const paren = seg === "" ? "" : `（${seg}）`;
  const mergedNote = r.merged > 0 ? ` · 模型整理 ${r.merged} 条` : "";
  return r.imported + u === 0 && r.skipped > 0
    ? `没有写入——${r.skipped} 条源内同名互撞全部跳过`
    : `已导入 ${r.imported} 条记忆${paren}${mergedNote} · /tool-peers__memory 可浏览`;
};

/** 镜像导入结果人话（G12，settings 硬编码中文——本文件 i18n 收编顺延 m5-i18n 批）：分段省略——
 *  各段为 0 即省、全零省整个括段；n = imported + updated（总写入）。codex（全局源）在镜像模式下
 *  仍导当前桶：其条数计入 {n}/{updated}/{skip}，{projects} 不 +1（当前项目非镜像定位项目）。 */
export const mirrorImportResultText = (r: { imported: number; updated: number; skipped: number; mirror: { projects: number; unresolved: number } }): string => {
  const seg = [
    ...(r.updated > 0 ? [`更新覆盖 ${r.updated} 条旧版`] : []),
    ...(r.skipped > 0 ? [`跳过 ${r.skipped} 条重复`] : []),
    ...(r.mirror.unresolved > 0 ? [`${r.mirror.unresolved} 个项目未能定位`] : []),
  ];
  const paren = seg.length === 0 ? "" : `（${seg.join(" · ")}）`;
  return `已导入 ${r.mirror.projects} 个项目共 ${r.imported + r.updated} 条${paren}`;
};

/** 结果文案分流（settings-ui 全屏/行模式共用）：镜像模式且 mirror 字段在场走 G12 串，否则原句。
 *  mode=all 但仅勾 codex 时 mirror 缺席（四家任一在场才出）——走原句式避免「0 个项目」歧义。 */
export const memoryImportResultFor = (mode: ImportScope, r: MemoryImportResult): string =>
  mode === "all" && r.mirror !== undefined
    ? mirrorImportResultText({ imported: r.imported, updated: r.updated ?? 0, skipped: r.skipped, mirror: r.mirror })
    : memoryImportResultText(r);
