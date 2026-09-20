import { basename } from "node:path";
import { PASTE_EMPTY, pasteOkHint } from "./paste.ts";

/** Alt+V 按键粘贴触发层（TUI 批 T5/V.2 移入项——ROADMAP「只补按键触发层」兑现）。
 *  keypress 多播拦截（机制①——不经 T0 解析器，v1.7 勘误）：readline 的 keypress 事件多播
 *  给所有监听者，匹配 meta+v 才触发，其余按键原样放行、行编辑零影响。触发后清当前行
 *  （readline 对未绑定 meta 序列可能残留控制字符）并重绘：提示独立成行、不带 `> ` 前缀
 *  （`> ` = 输入回显形态，带前缀会被误读成自己敲入的内容——v1.8 B3），结尾重绘提示符。
 *  提示语与 /paste 分支同源（paste.ts 常量）。非 TTY 不挂监听（退化矩阵：无 TTY 无按键流）。 */
export function attachAltVPaste(io: {
  input: { on(event: "keypress", listener: (s: string, k: { name?: string; meta?: boolean } | undefined) => void): unknown };
  isTTY: boolean;
  pasteImage(): Promise<{ file: string } | undefined>;
  write(s: string): void;
  clearInputLine(): void; // 宿主 readline 行缓冲清理面（rl.line = ""; rl.cursor = 0）
  setPendingImage(file: string): void;
}): void {
  if (!io.isTTY) return;
  const trigger = async (): Promise<void> => {
    const img = await io.pasteImage();
    io.clearInputLine();
    io.write(`\r\x1b[K${img === undefined ? PASTE_EMPTY : pasteOkHint(basename(img.file))}\n> `);
    if (img !== undefined) io.setPendingImage(img.file);
  };
  io.input.on("keypress", (_s, k) => {
    if (k?.name === "v" && k.meta === true) void trigger();
  });
}
