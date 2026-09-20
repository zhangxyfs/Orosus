import type { KeyEvent } from "./keys.ts";
import { moveUp, clearLine, reverse } from "./ansi.ts";

/** 视口计算（TUI 批 T2/B5 厂商目录分页）——纯函数：窗口由选中项派生（选中项置底边滚入、
 *  首部贴顶、尾部贴底），pick 渲染每帧经它取 [start, end)；PageUp/PageDown 把选中项
 *  ±height 后窗口随之滚动。height ≥ count 时恒整窗（{0, count}）。 */
export function viewportOf(count: number, selected: number, height: number): { start: number; end: number } {
  const h = Math.max(1, Math.min(height, Math.max(count, 1)));
  const start = Math.min(Math.max(0, selected - h + 1), Math.max(0, count - h));
  return { start, end: Math.min(count, start + h) };
}

/** 键盘菜单（TUI 批 T1/B5 第 2 层）——上下键反色高亮、回车确认、Esc 取消（reject 表达，
 *  menu.ts 侧映射为机制③统一文案）、≤9 项数字直达（设计空白：>9 项数字键让位导航）。
 *  T2 起支持滚动视口：io.height 注入且项数超窗时只画 [start, end) + 顶部范围提示行
 *  （…（第 X–Y 项，共 N 项）——帧高恒定，重绘算术不漂移），PageUp/PageDown 整屏翻页。
 *  非 TTY 回落现状编号读序号（脚本/CI 消费方零破坏，退化矩阵登记）。
 *  重绘 = 「上移 N 行 + 逐行清行 + 重写」——T4 起序列常量走 ansi.ts 公共件
 *  （moveUp/clearLine/reverse——字节形态不变，测试零改动）。 */
export function pick(
  items: string[],
  io: {
    isTTY: boolean;
    height?: number;
    runModal<T>(fn: (readKey: () => Promise<KeyEvent>) => Promise<T>): Promise<T>;
    write(s: string): void;
    numberQuestion(q: string): Promise<string>; // 非 TTY 回落路径（现状编号版）
  },
): Promise<number | undefined> {
  if (!io.isTTY) {
    return (async () => {
      for (;;) {
        const raw = (await io.numberQuestion("选择序号: ")).trim();
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
      }
    })();
  }
  return io.runModal(async (readKey) => {
    let selected = 0;
    // 视口仅在注入 height 且项数超窗时激活——否则整列渲染（T1 行为原样）
    const vpHeight = io.height !== undefined && io.height > 0 && items.length > io.height ? io.height : undefined;
    // 底部提示行文案按可用能力动态拼装（设计空白——防 >9 项/视口态提示撒谎）
    const hintParts = ["↑↓ 选择"];
    if (vpHeight !== undefined) hintParts.push("PgUp/PgDn 翻页");
    if (items.length <= 9) hintParts.push("数字直达");
    hintParts.push("回车确认", "Esc 取消");
    const hint = hintParts.join(" · ");
    const frameLines = (): string[] => {
      const win = vpHeight === undefined ? { start: 0, end: items.length } : viewportOf(items.length, selected, vpHeight);
      const lines: string[] = [];
      if (vpHeight !== undefined) lines.push(`…（第 ${win.start + 1}–${win.end} 项，共 ${items.length} 项）`);
      for (let i = win.start; i < win.end; i++) {
        const text = items[i]!.replace(/\n/g, " ");
        lines.push(i === selected ? reverse(text) : text);
      }
      lines.push(hint);
      return lines;
    };
    let drawn = 0;
    const render = (): void => {
      const lines = frameLines();
      if (drawn > 0) io.write(moveUp(drawn));
      for (const l of lines) io.write(`${clearLine}${l}\n`);
      drawn = lines.length;
    };
    render();
    for (;;) {
      const k = await readKey();
      if (k.type === "esc") throw new Error("已取消（Esc）");
      if (k.type === "enter") return selected;
      if (k.type === "arrow" && k.dir === "up") selected = (selected - 1 + items.length) % items.length;
      else if (k.type === "arrow" && k.dir === "down") selected = (selected + 1) % items.length;
      else if (k.type === "page" && k.dir === "up") selected = Math.max(0, selected - (vpHeight ?? items.length));
      else if (k.type === "page" && k.dir === "down") selected = Math.min(items.length - 1, selected + (vpHeight ?? items.length));
      else if (k.type === "char" && items.length <= 9 && /^[1-9]$/.test(k.ch)) {
        const n = Number(k.ch);
        if (n <= items.length) return n - 1;
        continue; // 超界数字——无状态变化
      } else continue; // 其余按键忽略——不重绘
      render();
    }
  });
}
