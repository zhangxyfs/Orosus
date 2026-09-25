/** 连山主题十色 + 派生色（TUI 批阶段三 F0——spike 验证件移植；TUI 批方案「连山主题」节原样）。
 *  组件只引语义名不写裸色值；truecolor SGR 38;2/48;2；COLORTERM 无 truecolor 时降级 256 色
 *  最近邻（启动时预计算）。派生色 = color-mix 预计算写死（accent/err 14% 叠 bg——原型
 *  accent-soft/err-soft 同义）。
 *  收尾口径（spike 第七轮实锤前案）：fg 收尾 `\x1b[39m` 只复位前景、bg 收尾 `\x1b[49m` 只复位
 *  背景——`\x1b[0m` 全复位会把外层 bg 一起清掉（bg 包裹内含 fg 片段时底色被洗成只剩框线的
 *  黑条）。bold/dim/underline/inverse 各有专属复位码（22m/23m/24m/27m），不受影响。 */

const TOKENS = {
	bg: "#0a100e",
	surface: "#121b17",
	surface2: "#18241e",
	fg: "#e9eee6",
	muted: "#97a49a",
	border: "#25352d",
	accent: "#7cc9a5",
	info: "#84b8cd",
	warn: "#d4a25e",
	err: "#d07f70",
	// diff 专属前景（2026-09-23 走查拍板——err #d07f70 赭石在 256 降级后偏橙被读成「黄」，
	// 用户要的是明确的红/绿；取 kimi diffAdded #4EC87E / diffRemoved #E85454 同值）
	diffAdd: "#4ec87e",
	diffDel: "#e85454",
	// color-mix 派生色预计算写死
	accentSoft: "#1a2a23",
	errSoft: "#26201c",
} as const;

export type TokenName = keyof typeof TOKENS;

// ---- 主题可切机制（m5 T12）：当前主题集可变 + 注册表 + 缓存失效——导出函数签名全不变（调用面 301 处零改动）。
// 本批仓内仅连山一套（决策点 20：主题包缓——机制先就绪，注册口供测试与将来主题包）。

/** 主题集形状（连山同构；值宽化为 string——外部主题包不必匹配字面量类型）。 */
export type ThemeTokens = { [K in TokenName]: string };

/** 主题注册表：名 → 色集。 */
export const THEMES = new Map<string, ThemeTokens>([["连山", TOKENS]]);

let activeName = "连山";
let active: ThemeTokens = TOKENS;

/** 注册主题（m5 T12：测试与将来主题包的入口）。 */
export function registerTheme(name: string, tokens: ThemeTokens): void {
  THEMES.set(name, tokens);
}

/** 切主题：换当前集 + 缓存失效；未知名抛错（设置服务转 reject——模块自行 catch）。
 *  效应只对新渲染面：流区已画出的历史行带着旧色值落在屏幕缓冲里不重刷（设计空白 11 披露）。 */
export function setTheme(name: string): void {
  const t = THEMES.get(name);
  if (t === undefined) throw new Error(`未知主题 "${name}"（可用：${[...THEMES.keys()].join("、")}）`);
  activeName = name;
  active = t;
  cache.clear();
}

/** 当前主题名（host 快照 theme 字段的数据源）。 */
export function activeThemeName(): string {
  return activeName;
}

function hexToRgb(hex: string): [number, number, number] {
	return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** xterm 256 色盘 RGB（16 基本色 + 216 立方 + 24 灰阶）。 */
function xterm256Rgb(n: number): [number, number, number] {
	if (n < 16) {
		const base: [number, number, number][] = [
			[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
			[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
		];
		return base[n]!;
	}
	if (n < 232) {
		const i = n - 16;
		const r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6;
		const lv = (v: number) => (v === 0 ? 0 : 55 + v * 40);
		return [lv(r), lv(g), lv(b)];
	}
	const v = 8 + (n - 232) * 10;
	return [v, v, v];
}

function nearest256(rgb: [number, number, number]): number {
	let best = 0;
	let bestD = Infinity;
	for (let n = 16; n < 256; n++) {
		const [r, g, b] = xterm256Rgb(n);
		const d = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
		if (d < bestD) {
			bestD = d;
			best = n;
		}
	}
	return best;
}

const truecolor =
	process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit" || process.env.WT_SESSION !== undefined;

const cache = new Map<string, { fg: string; bg: string }>();

function seq(name: TokenName): { fg: string; bg: string } {
	let hit = cache.get(name);
	if (hit) return hit;
	const rgb = hexToRgb(active[name] as string); // 当前主题集（m5 T12——缓存随 setTheme 失效重算）
	hit = truecolor
		? { fg: `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`, bg: `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` }
		: { fg: `\x1b[38;5;${nearest256(rgb)}m`, bg: `\x1b[48;5;${nearest256(rgb)}m` };
	cache.set(name, hit);
	return hit;
}

const RESET = "\x1b[0m";

/** 前景着色（收尾 `\x1b[39m` 只复位前景——文件头收尾口径）。 */
export function fg(name: TokenName, text: string): string {
	return seq(name).fg + text + "\x1b[39m";
}
/** 背景着色（收尾 `\x1b[49m` 只复位背景，同因）。 */
export function bg(name: TokenName, text: string): string {
	return seq(name).bg + text + "\x1b[49m";
}
/** 前景 + 背景。 */
export function paint(f: TokenName, b: TokenName, text: string): string {
	return seq(f).fg + seq(b).bg + text + "\x1b[39m\x1b[49m";
}
export function bold(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}
export function dim(text: string): string {
	return `\x1b[2m${text}\x1b[22m`;
}
export function underline(text: string): string {
	return `\x1b[4m${text}\x1b[24m`;
}
export function inverse(text: string): string {
	return `\x1b[7m${text}\x1b[27m`;
}
export { RESET, TOKENS };
