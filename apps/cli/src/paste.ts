import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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

/** pendingImages → prompt images opts（纯函数——main 接线一行消费，可测；F5 二轮⑬ 升多图）。
 *  空数组返回 undefined——prompt 第二参可省。 */
export function imagesFor(pendingImages: string[]): { images: string[] } | undefined {
  return pendingImages.length === 0 ? undefined : { images: [...pendingImages] };
}

/** /paste 命令与 Alt+V 按键（TUI 批 T5）两触发面的提示语同源常量——文案只此一份，两分支不漂移。 */
export const PASTE_EMPTY = "（剪贴板中没有图片——截图后重试，或检查终端权限）";
export const pasteOkHint = (name: string): string => `[已粘贴图片: ${name}]——将随下一条消息发送（需 vision 模型）`;

/** 图片尺寸读取（F5 二轮⑬——chip 形态 [image #2 (165×103)]）：PNG IHDR / GIF 头 / JPEG SOF 扫描；
 *  读不出返回 undefined（chip 退化为无尺寸形态）。纯读文件头，零依赖。 */
export function imageSize(file: string): { w: number; h: number } | undefined {
  try {
    const buf = readFileSync(file);
    // PNG：8 字节签名 + IHDR（len4+type4）后即宽高（大端）
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF：6 字节签名后宽高（小端 16 位）
    if (buf.length > 10 && buf.toString("latin1", 0, 3) === "GIF") {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // JPEG：扫 SOF 段（跳过 APPn）
    if (buf.length > 4 && buf.readUInt16BE(0) === 0xffd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) break;
        const marker = buf[off + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
    }
  } catch { /* 读失败 = 无尺寸 */ }
  return undefined;
}

/** 附件 chip 标签（F5 二轮⑬ 用户定稿形态）：[image #2 (165×103)]；尺寸缺失退化为 [image #2]。 */
export const imageChipLabel = (seq: number, file: string): string => {
  const sz = imageSize(file);
  return sz === undefined ? `[image #${seq}]` : `[image #${seq} (${sz.w}×${sz.h})]`;
};

/** 文内图片 token 提取（2026-09-23 走查拍板：chip 从独立行改为插入输入框光标位——用户可用
 *  删除键直接删 chip 文本 = 撤销挂图）：[image #N] / [image #N (W×H)] → seqs（出现序、去重）
 *  + 剥除 token 后的正文（行内空白收敛）。token 被删/改残即不匹配 = 图不随消息发出。 */
export function extractImageRefs(text: string): { cleaned: string; seqs: number[] } {
  const seqs: number[] = [];
  const cleaned = text
    .replace(/\[image #(\d+)(?: \(\d+×\d+\))?\]/g, (_m, n: string) => {
      const seq = Number(n);
      if (!seqs.includes(seq)) seqs.push(seq);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { cleaned, seqs };
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
