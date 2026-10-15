/** 跨 GUI 数据目录：~/.orosus/gui/。旧 ~/.orosus/web/ 文件只在首次启动迁移或回退读取时使用。 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export const guiDir = (home: string): string => join(home, "gui");
export const guiDataFile = (home: string, name: string): string => join(guiDir(home), name);
export const legacyWebDataFile = (home: string, name: string): string => join(home, "web", name);

/** 新路径在场优先；旧路径只作迁移前的兼容读取。 */
export function readGuiDataPath(home: string, name: string): string {
  const current = guiDataFile(home, name);
  return existsSync(current) ? current : legacyWebDataFile(home, name);
}

/** 将 Web 时代共享数据搬到 GUI 公共目录；新文件已存在时不覆盖，避免新状态被旧文件回滚。 */
export function migrateLegacyGuiFiles(home: string): void {
  for (const name of ["server.json", "pins.json", "workspaces.json"]) {
    const from = legacyWebDataFile(home, name);
    const to = guiDataFile(home, name);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(guiDir(home), { recursive: true });
    try {
      renameSync(from, to);
    } catch {
      // 文件被旧进程占用等情况下保留原文件；读取侧仍可走旧路径回退。
    }
  }
}
