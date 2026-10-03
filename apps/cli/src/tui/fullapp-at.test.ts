import { describe, it, expect } from "vitest";
import { atWordAt, filterEntries } from "./fullapp-at.ts";

/** m5-at-menu T1：纯函数层——光标处 @ 词解析（atWordAt）与条目过滤（filterEntries）直测。
 *  词判定口径（D1/D15）：原串扫描全部 @ 词，光标落在词区间 [start, start+词长]（含两端）即命中；
 *  @ 边界 = 行首或前一字符非路径合法字符（中文紧贴命中、邮箱不命中）——与斜杠形态互斥。 */

describe("m5-at-menu T1：atWordAt 光标处 @ 词解析", () => {
	it("① 根形态：`@sr` 光标串尾 → path 空（根目录）+ filter=sr", () => {
		expect(atWordAt("@sr", 3)).toEqual({ start: 0, path: "", filter: "sr" });
	});
	it("② 带路径：`@src/tui/ful` 光标串尾 → path=src/tui、filter=ful", () => {
		expect(atWordAt("@src/tui/ful", 12)).toEqual({ start: 0, path: "src/tui", filter: "ful" });
	});
	it("③ 无 @ 词返回 undefined", () => {
		expect(atWordAt("hello world", 5)).toBeUndefined();
	});
	it("④ 光标越过词后空格不命中（区间 [start, start+词长] 含两端——词右缘命中、空格之后失中）", () => {
		expect(atWordAt("@src 前言", 4)).toBeDefined(); // 词右缘（c 与空格之间）——含端点命中（打空格瞬间菜单仍开）
		expect(atWordAt("@src 前言", 5)).toBeUndefined(); // 空格之后（打完空格的落定位——编辑动作触发关）
		expect(atWordAt("@src 前言", 6)).toBeUndefined(); // 「前」上
	});
	it("⑤ 中文紧贴 `看下@sr` 命中（@ 前一字符「下」非路径合法字符）", () => {
		expect(atWordAt("看下@sr", 5)).toEqual({ start: 2, path: "", filter: "sr" });
	});
	it("⑥ 邮箱 `foo@bar.com` 不命中（@ 前是路径合法字符 o——词内 @ 不算起点）", () => {
		expect(atWordAt("联系 foo@bar.com", 10)).toBeUndefined();
	});
	it("⑦ 斜杠命令形态恒不命中（与斜杠菜单互斥的判定地基）", () => {
		expect(atWordAt("/help", 2)).toBeUndefined();
		expect(atWordAt("/title @src", 9)).toBeUndefined(); // 斜杠形态整条排除（normCmd 后仍 / 开头）
	});
	it("⑧ 多行中段词光标四态：词中/右缘/左缘命中、词外不命中", () => {
		const input = "前言\n看下@src/a.ts\n后语";
		// 词 `@src/a.ts`：start = 5（前0言1\n2看3下4）、词长 9 → 区间 [5, 14]
		expect(atWordAt(input, 8)).toEqual({ start: 5, path: "src", filter: "a.ts" }); // 词中
		expect(atWordAt(input, 14)).toEqual({ start: 5, path: "src", filter: "a.ts" }); // 右缘（s 与 \n 之间）
		expect(atWordAt(input, 5)).toEqual({ start: 5, path: "src", filter: "a.ts" }); // 左缘（@ 正左侧）
		expect(atWordAt(input, 4)).toBeUndefined(); // 词外（「下」上）
		expect(atWordAt(input, 15)).toBeUndefined(); // 词外（「后」上）
	});
	it("⑪ 多词条：光标落在哪条词上返回哪条（词间必有非词字符、不共光标）", () => {
		const input = "@a 前言 @b";
		expect(atWordAt(input, 2)).toEqual({ start: 0, path: "", filter: "a" }); // 词1 右缘
		expect(atWordAt(input, 8)).toEqual({ start: 6, path: "", filter: "b" }); // 词2 右缘（串尾）
		expect(atWordAt(input, 4)).toBeUndefined(); // 「前」「言」之间——两词界外
	});
	it("⑨ 串首词 cursor=0 命中（历史上翻光标落串首的形态——词区间起点 0 含光标 0）", () => {
		expect(atWordAt("@src/a.ts 你看看", 0)).toEqual({ start: 0, path: "src", filter: "a.ts" });
	});
	it("⑩ 裸 @ 空词命中（filter 空 = 根目录全显；刚打出 @ 光标在 @ 右）", () => {
		expect(atWordAt("看下@", 3)).toEqual({ start: 2, path: "", filter: "" });
	});
});

describe("m5-at-menu T1：filterEntries 过滤排序", () => {
	it("① 空过滤全显、目录组整体排在文件组前（组内维持传入序）", () => {
		const entries = [
			{ name: "readme.md", dir: false },
			{ name: "src", dir: true },
			{ name: "a.ts", dir: false },
			{ name: "tui", dir: true },
		];
		expect(filterEntries(entries, "")).toEqual([
			{ name: "src", dir: true },
			{ name: "tui", dir: true },
			{ name: "readme.md", dir: false },
			{ name: "a.ts", dir: false },
		]);
	});
	it("② 三档命中分组：前缀排前、含字居中（与斜杠菜单同口径、忽略大小写）", () => {
		const entries = [
			{ name: "ab.ts", dir: false },
			{ name: "b.ts", dir: false },
			{ name: "ba.ts", dir: false },
		];
		expect(filterEntries(entries, "B")).toEqual([
			{ name: "b.ts", dir: false },
			{ name: "ba.ts", dir: false },
			{ name: "ab.ts", dir: false },
		]);
	});
	it("③ 子序列档命中（isSubseq 同口径）+ 目录命中排文件前", () => {
		const entries = [
			{ name: "setup", dir: false },
			{ name: "sample", dir: true },
			{ name: "osp.ts", dir: false },
			{ name: "pass.ts", dir: false },
		];
		// 「sp」：sample 子序列（s…p）、osp.ts 含字、setup 子序列（s…p）、pass.ts 不命中（s 后无 p）
		expect(filterEntries(entries, "sp")).toEqual([
			{ name: "sample", dir: true },
			{ name: "osp.ts", dir: false },
			{ name: "setup", dir: false },
		]);
	});
});
