/** fullapp-at.ts（m5-at-menu T1）：@ 文件选择菜单纯函数层——光标处 @ 词解析 + 条目过滤。
 *  词判定（D1/D15）：原串扫描全部 @ 词（负向后顾边界——@ 在行首或前一字符非路径合法字符即词起点，
 *  中文紧贴 `看下@sr` 命中、邮箱 `foo@bar` 不命中），光标落在词区间 [start, start+词长]（含两端）即命中，
 *  串尾词是光标在串尾时的特例；斜杠命令形态整条排除（与斜杠菜单互斥的判定地基）。
 *  T2 在此挂 createAt 键族。非公开 API。 */

import { isSubseq, normCmd } from "./fullapp-types.ts";

/** @ 文件菜单条目（宿主经 io.atMenuEntries 供给——tui 家族无 fs 纪律，渲染与键族只消费）。 */
export interface AtEntry {
	name: string;
	dir: boolean;
}

/** @ 边界字符集（单一事实源，设计空白 6）：@ 前一字符属于此集 = @ 不算引用起点（邮箱 foo@bar 的
 *  @ 前是 o）。T4 发送侧 atfile.ts 的边界放宽改 import 此源——菜单触发与发送解析两侧永不漂移；
 *  要动这个集合 = 两侧同动 + atfile 全测重跑。放本件（而非 atfile.ts）导出的理由：tui 家族
 *  保持无 fs（atfile.ts 顶部 import node:fs，tui 件 import 它会把 fs 拉进模块图——方向反转，
 *  atfile → tui 单向依赖，apps 层内跨目录 import 有先例）。 */
export const AT_PATH_BOUNDARY_SRC = "A-Za-z0-9_\\-./\\\\~";

/** 光标处 @ 词解析：命中返回词起点（含 @、原串原生坐标——词区间替换直接可用，不吃正文中段同串）、
 *  path（词内最后一个 / 之前的部分，无 / = 空串即根目录）、filter（最后一个 / 之后的部分）。
 *  不命中（光标不在任何词区间 / 所在词 @ 前是路径合法字符 / 斜杠命令形态）返回 undefined——
 *  光标在词后空格之后天然不命中（词区间只到词尾含端点）。cursor 按调用点传实（state.cursor 原串偏移；
 *  召回三分支的光标落位各不相同——队列/下翻串尾、历史上翻串首）。 */
export function atWordAt(input: string, cursor: number): { start: number; path: string; filter: string } | undefined {
	if (normCmd(input).startsWith("/")) return undefined; // 斜杠命令形态整条排除（互斥地基）
	for (const m of input.matchAll(new RegExp(`(?<![${AT_PATH_BOUNDARY_SRC}])@([^#\\s]*)`, "g"))) {
		const start = m.index!;
		if (cursor >= start && cursor <= start + m[0].length) {
			const word = m[0].slice(1); // 去 @
			const slash = word.lastIndexOf("/");
			return { start, path: slash === -1 ? "" : word.slice(0, slash), filter: slash === -1 ? word : word.slice(slash + 1) };
		}
	}
	return undefined;
}

/** 条目过滤 + 排序成型：三档命中（前缀排前、含字居中、子序列殿后——isSubseq 与斜杠菜单三档同口径、
 *  忽略大小写）组内维持传入序；目录组整体排在文件组前（D6）。空过滤全显（D5——含点文件与
 *  node_modules，按字面全显）。 */
export function filterEntries(entries: AtEntry[], filter: string): AtEntry[] {
	if (filter === "") return [...entries.filter((e) => e.dir), ...entries.filter((e) => !e.dir)];
	const q = filter.toLowerCase();
	const byTier = (dir: boolean): AtEntry[] => {
		const hits: AtEntry[] = [];
		const more: AtEntry[] = [];
		const fuzzy: AtEntry[] = [];
		for (const e of entries) {
			if (e.dir !== dir) continue;
			const n = e.name.toLowerCase();
			if (n.startsWith(q)) hits.push(e);
			else if (n.includes(q)) more.push(e);
			else if (isSubseq(q, n)) fuzzy.push(e);
		}
		return [...hits, ...more, ...fuzzy];
	};
	return [...byTier(true), ...byTier(false)];
}
