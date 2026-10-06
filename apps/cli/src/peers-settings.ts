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

/** 记忆导入数据口（走查修订三：settings 侧 = 引导第 5 页同功能·简版——纯机械导入零 token，
 *  模型整理开关是引导专属〔D20 当次生效不落盘〕不进设置面）。宿主接线复用 importers 件。 */
export interface MemoryImportDeps {
  /** 五源探测（有货才列：count > 0）。 */
  detect(): { id: string; label: string; count: number }[];
  /** 执行导入（标题精确去重，已导入过的跳过）。 */
  run(sourceIds: string[]): { imported: number; skipped: number };
}

/** 「记忆导入」流：有货源逐项 / 全部导入；无货源空态文案可跳过。返回人话结果（toast/out 用；空串 = Esc）。 */
export async function runMemoryImportSetting(
  choose: (title: string, items: string[]) => Promise<string>,
  deps: MemoryImportDeps,
): Promise<string> {
  const sources = deps.detect().filter(s => s.count > 0);
  if (sources.length === 0) return "本机没有检测到可导入的记忆——支持 Claude Code / ZCode / qwen / codex / Reasonix 五家（在对应工具里先记几条再来）";
  const total = sources.reduce((n, s) => n + s.count, 0);
  const items = [
    ...sources.map(s => `${s.label} —— 导入该源 ${s.count} 条`),
    `全部导入 —— ${sources.length} 家共 ${total} 条`,
  ];
  const picked = await choose("记忆 · 导入", items);
  const idx = items.indexOf(picked);
  if (idx === -1) return "";
  const ids = idx < sources.length ? [sources[idx]!.id] : sources.map(s => s.id);
  const r = deps.run(ids);
  return r.imported === 0 && r.skipped > 0
    ? `没有新条目——${r.skipped} 条全部与现有记忆重复（此前已导入过）`
    : `已导入 ${r.imported} 条记忆（跳过 ${r.skipped} 条重复）· /tool-peers__memory 可浏览`;
}
