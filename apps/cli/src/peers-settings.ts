import { join, dirname } from "node:path";
import { loadConfig, writeSectionKey, sectionPath } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";

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

/** 记忆导入数据口（走查修订三 + 走查八：settings 侧 = 引导第 5 页同功能——含 D20 模型整理〔逐条
 *  内容优化 + 重写 description，走查八-③ 重定义〕与进度回调）。宿主接线复用 importers 件 + h.llm()。 */
export interface MemoryImportDeps {
  /** 五源探测（有货才列：count > 0）。 */
  detect(): { id: string; label: string; count: number }[];
  /** 执行导入（organize = true 逐条模型整理；onProgress **前置**每条一步；signal = Alt+C 强停——
   *  剩余条目原样落盘，导入照常完成〔部分整理〕）。 */
  run(sourceIds: string[], organize: boolean, onProgress?: (done: number, total: number, title: string) => void, signal?: AbortSignal): Promise<{ imported: number; skipped: number; merged: number }>;
}

/** 「记忆导入」选择段（走查八-④：整理是**开关**项——开启后不论全部导入还是单源导入都走整理）：
 *  菜单 = 每源一项 + 全部导入 + 「用模型整理」开关行（回车/空格切换，当次会话态不落盘）。
 *  返回 { ids, organize }（执行段由调用方跑——全屏接进度弹窗）；"empty" = 无货源；undefined = Esc。 */
export async function runMemoryImportChoose(
  choose: (title: string, items: string[]) => Promise<string>,
  deps: MemoryImportDeps,
  initialOrganize = false,
): Promise<{ ids: string[]; organize: boolean } | "empty" | undefined> {
  const sources = deps.detect().filter(s => s.count > 0);
  if (sources.length === 0) return "empty";
  const total = sources.reduce((n, s) => n + s.count, 0);
  const organizeRow = (on: boolean): string => `用模型整理 —— ${on ? "开 ✓" : "关"}（逐条优化内容 + 重写摘要，消耗 token 一次性；开启后所有导入路径都走整理）`;
  let organize = initialOrganize;
  for (;;) {
    const items = [
      ...sources.map(s => `${s.label} —— 导入该源 ${s.count} 条`),
      `全部导入 —— ${sources.length} 家共 ${total} 条`,
      organizeRow(organize),
    ];
    const picked = await choose("记忆 · 导入", items);
    const idx = items.indexOf(picked);
    if (idx === -1) return undefined;   // Esc
    if (idx === items.length - 1) { organize = !organize; continue; }   // 开关行：切换后菜单刷新（✓ 移位）
    return {
      ids: idx < sources.length ? [sources[idx]!.id] : sources.map(s => s.id),
      organize,
    };
  }
}

/** 导入结果人话（执行段完成后的 toast/out 文案）。 */
export const memoryImportResultText = (r: { imported: number; skipped: number; merged: number }): string => {
  const mergedNote = r.merged > 0 ? ` · 模型整理 ${r.merged} 条` : "";
  return r.imported === 0 && r.skipped > 0
    ? `没有新条目——${r.skipped} 条全部与现有记忆重复（此前已导入过）${mergedNote}`
    : `已导入 ${r.imported} 条记忆（跳过 ${r.skipped} 条重复）${mergedNote} · /tool-peers__memory 可浏览`;
};
