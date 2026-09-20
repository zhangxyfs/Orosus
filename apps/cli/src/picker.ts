import type { KeyEvent } from "./keys.ts";

/** 键盘菜单（TUI 批 T1/B5 第 2 层）——上下键反色高亮、回车确认、Esc 取消（reject 表达，
 *  menu.ts 侧映射为机制③统一文案）、≤9 项数字直达（设计空白：>9 项数字键让位导航）。
 *  非 TTY 回落现状编号读序号（脚本/CI 消费方零破坏，退化矩阵登记）。
 *  重绘 = 「上移 N 行 + 逐行清行 + 重写」最简版（约 10 行）——T4 开工时与 liveview 一起
 *  抽 ansi.ts 公共件（序列常量不变，测试零改动）。 */
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
    // 底部提示行文案随数字直达可用性切换（设计空白——防 >9 项时提示撒谎）
    const hint = items.length <= 9 ? "↑↓ 选择 · 回车确认 · 数字直达 · Esc 取消" : "↑↓ 选择 · 回车确认 · Esc 取消";
    const frameLines = (): string[] => [
      ...items.map((x, i) => {
        const text = x.replace(/\n/g, " ");
        return i === selected ? `\x1b[7m${text}\x1b[27m` : text;
      }),
      hint,
    ];
    let drawn = 0;
    const render = (): void => {
      const lines = frameLines();
      if (drawn > 0) io.write(`\x1b[${drawn}A\r`);
      for (const l of lines) io.write(`\x1b[K${l}\n`);
      drawn = lines.length;
    };
    render();
    for (;;) {
      const k = await readKey();
      if (k.type === "esc") throw new Error("已取消（Esc）");
      if (k.type === "enter") return selected;
      if (k.type === "arrow" && k.dir === "up") selected = (selected - 1 + items.length) % items.length;
      else if (k.type === "arrow" && k.dir === "down") selected = (selected + 1) % items.length;
      else if (k.type === "char" && items.length <= 9 && /^[1-9]$/.test(k.ch)) {
        const n = Number(k.ch);
        if (n <= items.length) return n - 1;
        continue; // 超界数字——无状态变化
      } else continue; // 其余按键忽略——不重绘
      render();
    }
  });
}
