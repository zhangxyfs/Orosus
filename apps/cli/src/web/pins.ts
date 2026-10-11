/** 置顶读写（web 批 T9，B2）：~/.orosus/web/pins.json（sid 数组，0600——GC9 web 私有数据根）。
 *  纯文件面：读侧坏件降级空表；写侧 mkdir 保底 + 0600 权限（instance.ts 同款私有数据纪律）。
 *  顺序语义：数组序 = 置顶区显示序（插入序）；去重由 toggle 保证。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function pinsFile(home: string): string {
  return join(home, "web", "pins.json");
}

/** 读置顶表（坏件/缺文件 → 空表；非字符串成员滤除——防手改脏件炸列表）。 */
export function readPins(home: string): string[] {
  try {
    const o = JSON.parse(readFileSync(pinsFile(home), "utf8")) as unknown;
    if (!Array.isArray(o)) return [];
    return o.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** 写置顶表（0600；web 目录 mkdir 保底）。 */
export function writePins(home: string, sids: string[]): void {
  mkdirSync(join(home, "web"), { recursive: true });
  writeFileSync(pinsFile(home), JSON.stringify(sids), { mode: 0o600 });
}

/** 置顶/取消（toggle）：在场则移除、不在则追加；返回操作后是否处于置顶态。 */
export function togglePin(home: string, sid: string): boolean {
  const pins = readPins(home);
  const next = pins.includes(sid) ? pins.filter((s) => s !== sid) : [...pins, sid];
  writePins(home, next);
  return next.includes(sid);
}
