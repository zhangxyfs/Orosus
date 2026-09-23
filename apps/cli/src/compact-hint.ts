/** /compact 执行进度指示（TUI 批 T7——压缩调研 P1 残余，决策点⑤默认纳入）。
 *  机制⑤（v1.8 重写）：/compact 是模块命令，在 h.prompt 的命令路由里同步执行，宿主在 await 期间
 *  没有钩子；其结果是命令返回串、经 console 输出——**不经 liveview 写面**，「下一次写入自然覆写」
 *  永不发生。故定形：h.prompt 前经 liveview.activity 写指示行（临时活动区），settle（返回或抛错）
 *  后 discard 显式擦除（内容不固化、上移清尾归 direct），再由 console 输出结果——视觉上指示行
 *  被结果替换。成功/失败同款；零契约扩展、不碰 compaction 模块。非 TTY 零输出变化（硬约束 3）。
 *  2026-09-23 用户拍板 UI 形态：文案改「上下文压缩中…」（全屏 busy spinner 同文案 + 石青 info 色，
 *  经 io.fullscreen enter/exit 钩子切换）；行模式 activity 行同文案。 */

export const COMPACT_HINT = "上下文压缩中…";

/** 命令归一化与 core 命令路由同口径（harness.ts:503-505 同源复制——斜杠后空格抹除 +
 *  连续空白折叠；` /compact `、`/ compact`、全角空格变体与 core 同款可解析即同款命中）。
 *  严格边界 `/^\/compact(?:\s|$)/`：`/compactx` 这类未知命令不误写指示行（v1.6 收紧——
 *  原稿 startsWith 前缀命中会把未知命令盖上指示行且无处擦除）。 */
export function isCompactCommand(line: string): boolean {
  const cmdText = line.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " ");
  return /^\/compact(?:\s|$)/.test(cmdText);
}

/** TTY 且命中 /compact 时包裹 run：行模式经 activity 写指示行（settle 后 finally discard 擦除）；
 *  全屏期经 io.fullscreen.enter/exit 切换 busy spinner 专属形态（全屏不走 lv——直写 stdout 毁 alt-screen，
 *  spinner 已承载进度语义）。
 *  非 TTY 或未命中 → 直透 run（activity/discard/enter/exit 均不触达——管道 stdout 零字节变化）。 */
export async function withCompactHint<T>(
  line: string,
  io: {
    isTTY: boolean;
    activity(s: string): void;
    discard(): void;
    fullscreen?: { enter(text: string): void; exit(): void } | undefined;
  },
  run: () => Promise<T>,
): Promise<T> {
  if (io.isTTY !== true || !isCompactCommand(line)) return run();
  io.fullscreen?.enter(COMPACT_HINT);
  if (io.fullscreen === undefined) io.activity(COMPACT_HINT);
  try {
    return await run();
  } finally {
    io.fullscreen?.exit();
    io.discard();
  }
}
