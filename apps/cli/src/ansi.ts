/** 重绘与显示宽公共件（TUI 批 T4/B5——自 T1 picker 抽取升格；序列常量不变，picker 测试零改动）。
 *  显示宽口径（设计空白登记）：剥 ANSI 转义后按码点计——全角区间 2 列、其余（含 Ambiguous
 *  图标 ❯⏺◐✓ 与 █░ 块元素）1 列；简版 wcwidth 覆盖 CJK 主区间与 emoji 平面，不走完整
 *  Unicode 表（零依赖维持）。重绘「上移 N 行」的 N 必须按视觉行数算——CJK 双宽导致终端
 *  折行数 ≠ 逻辑行数，是本批最大深水区（方案 T4 为什么节）。 */

/** 上移 n 行并回行首（picker/liveview 重绘共用）。 */
export const moveUp = (n: number): string => `\x1b[${n}A\r`;
/** 清当前行（Erase in Line——写新内容前逐行清残）。 */
export const clearLine = "\x1b[K";
/** 清光标到屏尾（重绘帧缩短时擦除尾部陈旧行）。 */
export const clearToEnd = "\x1b[0J";
/** 反色包裹（菜单当前项高亮）。 */
export const reverse = (s: string): string => `\x1b[7m${s}\x1b[27m`;

/** CSI 转义序列匹配（颜色/光标/清屏全形态——测宽前剥除，转义零宽）。 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** 单码点显示宽：全角（CJK 主区间/全角形式/emoji 平面）= 2，其余 = 1（Ambiguous 从 1，已登记）。 */
const cpWidth = (cp: number): number =>
  (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
  (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首/表意空格（U+3000）
  (cp >= 0x3041 && cp <= 0x33ff) || // 假名/CJK 符号/方头兼容
  (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
  (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
  (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文音节
  (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
  (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
  (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
  (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
  (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
  cp >= 0x20000 // CJK 扩展 B+ 与 emoji 平面
    ? 2
    : 1;

/** 字符串显示宽：ANSI 转义零宽（剥除后测宽——思考块 dim 序列不误算折行）。 */
export function dispWidth(s: string): number {
  const plain = s.replace(ANSI_RE, "");
  let w = 0;
  for (const ch of plain) w += cpWidth(ch.codePointAt(0)!);
  return w;
}

/** 单行（不含 \n）在 columns 宽终端里的视觉折行数——⌈宽/列⌉，空行 1 行，列数下限 1 防除零。 */
export function dispLineRows(s: string, columns: number): number {
  const c = Math.max(1, columns);
  return Math.max(1, Math.ceil(dispWidth(s) / c));
}

/** 多行文本的总视觉行数（split("\n") 后逐行折算求和——重绘上移行数的唯一口径）。 */
export function dispLines(s: string, columns: number): number {
  return s.split("\n").reduce((n, l) => n + dispLineRows(l, columns), 0);
}
