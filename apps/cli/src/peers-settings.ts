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

/** 「记忆」子菜单切换流：回车即切换并写键；返回 { key, value, message }（写盘已发生，reload 由调用方收尾）。
 *  undefined = Esc/未匹配（回上一级）。文案带 token 消耗提示（v2 用户走查定案）。 */
export async function runMemoryToggleSetting(
  choose: (title: string, items: string[]) => Promise<string>,
  cfgFile: string = join(orosusHome(), "config.toml"),
): Promise<{ key: "workspaceMemory" | "sessionPeers"; value: boolean; message: string } | undefined> {
  const cfg = readPeersConfig(cfgFile);
  const items = [
    `工作区记忆 —— ${cfg.workspaceMemory ? "开 ✓" : "关"}（共享笔记 + 索引注入：本会话写、其他会话读；开启后系统提示带记忆索引，有 token 消耗）`,
    `会话感知 —— ${cfg.sessionPeers ? "开 ✓" : "关"}（查同伴 / 文件占用：peers 查询对每个活会话按需做一句话总结，有 token 消耗）`,
  ];
  const picked = await choose("记忆", items);
  const idx = items.indexOf(picked);
  if (idx !== 0 && idx !== 1) return undefined;
  const key: "workspaceMemory" | "sessionPeers" = idx === 0 ? "workspaceMemory" : "sessionPeers";
  const value = !(idx === 0 ? cfg.workspaceMemory : cfg.sessionPeers);
  writePeersConfigKey(key, value, cfgFile);
  const label = idx === 0 ? "工作区记忆" : "会话感知";
  return { key, value, message: `${label}：${value ? "开" : "关"}（已写 [tool-peers] ${key}）` };
}
