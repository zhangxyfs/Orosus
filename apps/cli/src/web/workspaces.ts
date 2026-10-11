/** 工作区显隐表（web 批 T9，B10）：~/.orosus/web/workspaces.json {v:1, hidden:[cwd…]}。
 *  语义 = 纯显隐（仅左栏过滤——文件与会话保留）；找回 = 用该 cwd 建会话自动移出
 *  （api-session POST /api/sessions 接线）+ unarchive 的 cwd 联动 unhide（§3 端点注释）。
 *  坏件降级空表；写侧 mkdir 保底 + 0600（pins.ts 同款私有数据纪律）。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function workspacesFile(home: string): string {
  return join(home, "web", "workspaces.json");
}

/** 读隐藏工作区表（坏件/缺文件 → 空表；非字符串成员滤除）。 */
export function readHidden(home: string): string[] {
  try {
    const o = JSON.parse(readFileSync(workspacesFile(home), "utf8")) as { v?: unknown; hidden?: unknown };
    if (!Array.isArray(o.hidden)) return [];
    return o.hidden.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function writeHidden(home: string, hidden: string[]): void {
  mkdirSync(join(home, "web"), { recursive: true });
  writeFileSync(workspacesFile(home), JSON.stringify({ v: 1, hidden }), { mode: 0o600 });
}

/** 移除工作区（仅显隐）：幂等（已在表 = no-op）。 */
export function hideCwd(home: string, cwd: string): void {
  const hidden = readHidden(home);
  if (hidden.includes(cwd)) return;
  writeHidden(home, [...hidden, cwd]);
}

/** 移出隐藏表（找回）：返回是否真的移除了（不在表 = false，幂等）。 */
export function unhideCwd(home: string, cwd: string): boolean {
  const hidden = readHidden(home);
  if (!hidden.includes(cwd)) return false;
  writeHidden(home, hidden.filter((s) => s !== cwd));
  return true;
}
