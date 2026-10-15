/** 置顶读写：~/.orosus/gui/pins.json（sid 数组，0600；旧 ~/.orosus/web/ 仅作迁移前回退）。
 *  纯文件面：读侧坏件降级空表；写侧 mkdir 保底 + 0600 权限（instance.ts 同款私有数据纪律）。
 *  顺序语义：数组序 = 置顶区显示序（插入序）；去重由 toggle 保证。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { guiDataFile, guiDir, readGuiDataPath } from "./gui-files.ts";

export function pinsFile(home: string): string {
  return guiDataFile(home, "pins.json");
}

/** 读置顶表（坏件/缺文件 → 空表；非字符串成员滤除——防手改脏件炸列表）。 */
export function readPins(home: string): string[] {
  try {
    const o = JSON.parse(readFileSync(readGuiDataPath(home, "pins.json"), "utf8")) as unknown;
    if (!Array.isArray(o)) return [];
    return o.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** 写置顶表（0600；gui 目录 mkdir 保底）。 */
export function writePins(home: string, sids: string[]): void {
  mkdirSync(guiDir(home), { recursive: true });
  writeFileSync(pinsFile(home), JSON.stringify(sids), { mode: 0o600 });
}

/** 置顶/取消（toggle）：在场则移除、不在则追加；返回操作后是否处于置顶态。 */
export function togglePin(home: string, sid: string): boolean {
  const pins = readPins(home);
  const next = pins.includes(sid) ? pins.filter((s) => s !== sid) : [...pins, sid];
  writePins(home, next);
  return next.includes(sid);
}
