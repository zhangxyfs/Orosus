/** 回合结束提示音（2026-09-30 用户拍板）：turn 终态写终端 BEL——完成 1 响 / 中断 2 响 / 错误 3 响
 *  （响数区分结局，不用看屏就知道该不该回来）。BEL 是终端自消费控制符（不进屏幕缓冲），全屏/
 *  行模式两形态都安全；静音归终端设置管（Windows Terminal 的 bell notification style），本侧只留
 *  [tui] bell = false 一档关法。写面注入可测；多响间隔 150ms 防终端合并成一声。 */
export const BELL_GAP_MS = 150;

/** 终态 → 响数（纯函数）：completed=1 / interrupted=2 / error=3 / 其余（未知形态）0 不响。 */
export function bellCount(kind: unknown): number {
  if (kind === "error") return 3;
  if (kind === "interrupted") return 2;
  if (kind === "completed") return 1;
  return 0;
}

/** 按终态响铃：首响同步写（回合结束即反馈），余响 setTimeout 错峰（unref 不拖进程退出）。 */
export function ringTurnBell(kind: unknown, write: (s: string) => void): void {
  const n = bellCount(kind);
  if (n <= 0) return;
  write("\x07");
  for (let i = 1; i < n; i++) {
    const t = setTimeout(() => write("\x07"), BELL_GAP_MS * i);
    t.unref?.();
  }
}
