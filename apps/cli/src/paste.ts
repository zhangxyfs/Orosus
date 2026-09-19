import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { orosusHome } from "@orosus/contracts/home";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

/** PowerShell 取图参数（纯函数——可测）。路径转正斜杠防 PS 双引号转义歧义。 */
export function psCommandFor(tmp: string): string[] {
  return ["-NoProfile", "-Command",
    `Get-Clipboard -Format Image | ForEach-Object { $_.Save('${tmp.replace(/\\/g, "/")}', 'PNG') }`];
}

/** 最小有效字节数 100（纯函数——可测；防 PowerShell 输出空文件被误认有图）。 */
export function isMeaningfulImage(size: number): boolean {
  return size > 100;
}

/** pendingImage → prompt images opts（纯函数——main 接线一行消费，可测；M4-2.5 T5 装配锚，withImageRef 同位）。
 *  返回 undefined 表示无挂起图——prompt 第二参可省。 */
export function imagesFor(pendingImage: string | undefined): { images: string[] } | undefined {
  return pendingImage === undefined ? undefined : { images: [pendingImage] };
}

/** 从系统剪贴板读取图片（M4-2 T10；M4-2.5 T5 起随消息真实喂图）。
 *  返回保存的 PNG 文件路径；剪贴板无图返回 undefined。
 *  路径以 image part 进 user/message（日志存路径、请求期翻译层转 base64）。 */
export async function pasteImage(): Promise<{ file: string } | undefined> {
  const tmp = join(orosusHome(), "tmp", `paste-${Date.now()}.png`);
  mkdirSync(dirname(tmp), { recursive: true });
  try {
    if (process.platform === "win32") {
      await execFileAsync("powershell", psCommandFor(tmp));
    } else if (process.platform === "darwin") {
      await execFileAsync("osascript", ["-e",
        `write (the clipboard as «class PNGf») to (open for access "${tmp}" with write permission)`]);
    } else {
      await execFileAsync("sh", ["-c",
        `xclip -selection clipboard -t image/png -o > "${tmp}" 2>/dev/null || wl-paste --type image/png > "${tmp}" 2>/dev/null`]);
    }
  } catch { /* 平台命令失败 → 无图 */ }
  return existsSync(tmp) && isMeaningfulImage(statSync(tmp).size) ? { file: tmp } : undefined;
}
