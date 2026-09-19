import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
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

/** pendingImage 附着（纯函数——main 接线一行消费，可测）。 */
export function withImageRef(text: string, image: string | undefined): string {
  return image === undefined ? text : `${text}\n[图片: ${image}]`;
}

/** 从系统剪贴板读取图片（M4-2 T10）。
 *  返回保存的 PNG 文件路径；剪贴板无图返回 undefined。
 *  效力边界见方案任务头部：M4-2 = 文件 + 路径引用；真实喂图 V.2（ContentPart 无 image 形态）。 */
export async function pasteImage(): Promise<{ file: string } | undefined> {
  const tmp = join(homedir(), ".orosus", "tmp", `paste-${Date.now()}.png`);
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
