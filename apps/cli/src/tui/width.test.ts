import { describe, it, expect } from "vitest";
import { dispLines, osc8LinkAtColumn, padToWidth, sliceByColumn, stripAnsi, truncateToWidth, visibleWidth, wrapText } from "./width.ts";

describe("宽度引擎（TUI 批阶段三 F0——pi-tui utils 零依赖移植）", () => {
	it("① CJK 折行：12 个全角字在 10 列宽折 3 行（24 显示宽 ÷ 10 列向上取整）", () => {
		expect(wrapText("中文中文中文中文中文中文", 10)).toHaveLength(3);
		expect(dispLines("中文中文中文中文中文中文", 10)).toBe(3);
	});
	it("② VS16 emoji 宽 2、ambiguous=1、代理对不拆", () => {
		expect(visibleWidth("☀️")).toBe(2); // U+2600 + VS16
		expect(visibleWidth("❯⏺◐✓")).toBe(4); // ambiguous 图标各 1
		expect(wrapText("😀😀😀", 3)).toEqual(["😀", "😀", "😀"]); // 每字 2 列、3 列宽每行 1 个——不拆代理对
	});
	it("③ ANSI/OSC/APC 转义零宽（剥除后测宽）", () => {
		expect(visibleWidth("\x1b[31m中文\x1b[39m")).toBe(4);
		expect(stripAnsi("\x1b[38;2;1;2;3m甲\x1b]8;;http://x\x07乙\x1b]8;;\x07\x1b_pi:c\x07")).toBe("甲乙");
	});
	it("④ wrapText 的 ANSI 状态跨行延续（折行处状态带入下一行防色漏）", () => {
		const red = "\x1b[31m" + "甲".repeat(12) + "\x1b[39m";
		const lines = wrapText(red, 8); // 12 全角 = 24 宽，8 列 → 3 行
		expect(lines).toHaveLength(3);
		expect(lines[1]!.startsWith("\x1b[31m")).toBe(true); // 第二行继承红色前缀
		expect(lines[0]!.endsWith("\x1b[0m")).toBe(true); // 首行末尾复位防漏色
	});
});

describe("CJK 禁则（2026-09-24 用户拍板——「名字（长URL）」段落行尾孤「（」乱象）", () => {
	it("⑤ 开括号不收行尾：URL 词原子掉行时「（」随之下移（截图 1:1 场景）", () => {
		const text = "来源：中国天气网北京站（http://bj.weather.com.cn/sygdt/09/4802051_m.shtml）· 中央气象台（https://www.nmc.cn/publish/forecast/ABJ/beijing.html）";
		const lines = wrapText(text, 78);
		for (const l of lines) expect(l.endsWith("（")).toBe(false); // 旧行为：每行以孤「（」收尾
		expect(stripAnsi(lines.join("")).replace(/ /g, "")).toBe(text.replace(/ /g, "")); // 无内容丢失（断点空格合法吞掉）
		expect(lines.some((l) => l.includes("http://bj.weather.com.cn"))).toBe(true); // URL 完整不被劈
	});

	it("⑥ 行首闭排印：。、）等不落在行首（上一单元带下去）", () => {
		const lines = wrapText("北京天气晴。明天呢。好的。", 8);
		for (const l of lines) expect(l).not.toMatch(/^[）。，、；：！？…·]/); // 行首禁则
		expect(lines.join("")).toBe("北京天气晴。明天呢。好的。"); // 无内容丢失
	});

	it("⑦ URL 词原子不回归 + OSC 链接边界保守跳过禁则不炸", () => {
		const fits = wrapText("see http://abc.example/x here", 34);
		expect(fits).toHaveLength(1); // 整行装得下——零折行
		const linked = "看（\x1b]8;;http://x.example/a/b\x07http://x.example/a/b\x1b]8;;\x07）完";
		const lines = wrapText(linked, 20);
		expect(stripAnsi(lines.join(""))).toBe("看（http://x.example/a/b）完"); // OSC 链接内容无损
	});
});

describe("OSC 8 链接探测（m5 鼠标批 T7——kimi utils.ts:344-366 精简：只认行内 OSC 8 码自产自销）", () => {
	const line = "前缀 \x1b]8;;https://x.com/a\x07链接字\x1b]8;;\x07 后缀";
	it("① 命中链接文本列返回 URL；非链接列与闭合后区域 undefined", () => {
		expect(osc8LinkAtColumn(line, 5)).toBe("https://x.com/a"); // 「链」列（前缀 = 前0-1 缀2-3 空格4）
		expect(osc8LinkAtColumn(line, 7)).toBe("https://x.com/a"); // 「字」列
		expect(osc8LinkAtColumn(line, 0)).toBeUndefined(); // 前缀段
		expect(osc8LinkAtColumn(line, 11)).toBeUndefined(); // 闭合后（空格10 + 后缀段）
	});
	it("② 宽度地基：OSC 8 包裹行 visibleWidth 与裸文本一致（extractAnsiCode 已认 OSC）", () => {
		expect(visibleWidth(line)).toBe(visibleWidth(stripAnsi(line)));
	});
});

describe("sliceByColumn 严格语义 + 起点前 SGR 回放（CTW-03 回归钉 2026-09-28——左跨界宽字符双端计入 + 切点前样式丢失，消费方：选区三段切/overlay 合成）", () => {
	it("⑧ 左跨界宽字符不再双端计入：「汉abc」切 [0,1)+[1,3) 合计显示宽 4 = 窗宽 [0,4)（旧相交语义同一「汉」进两段、合计 6 > 4）", () => {
		const a = sliceByColumn("汉abc", 0, 1); // 汉起点 col 0 ∈ [0,1) → 计入（整字 2 列）
		const b = sliceByColumn("汉abc", 1, 3); // 汉起点 col 0 < 1 → 严格排除（旧：相交计入 → 同字两屏）
		expect(stripAnsi(a)).toBe("汉");
		expect(stripAnsi(b)).toBe("ab");
		expect(visibleWidth(a) + visibleWidth(b)).toBe(4); // 两段拼回恰好铺满窗 [0,4)——旧 2+4=6
	});
	it("⑨ 逐列切分重组无损：起点对齐 grapheme 边界的切片拼接 = 原行可见文本（选区三段切的地基）", () => {
		const line = "汉abcde";
		const segs = [sliceByColumn(line, 0, 2), sliceByColumn(line, 2, 3), sliceByColumn(line, 5, 99)];
		expect(segs.map((s) => stripAnsi(s)).join("")).toBe("汉abcde");
	});
	it("⑩ 起点前 SGR 回放：切点落在着色段中间，切片自带切点前激活样式（pi pendingAnsi 同构；旧实现 mid/after 段掉色）", () => {
		const line = "前\x1b[31m红字\x1b[39m尾"; // 前[0,2) 红[2,4) 字[4,6) 尾[6,7)
		const mid = sliceByColumn(line, 4, 2); // 从「字」起——31m 在切点前
		expect(mid.startsWith("\x1b[31m")).toBe(true); // 回放起点前样式
		expect(stripAnsi(mid)).toBe("字");
		const after = sliceByColumn(line, 6, 5); // 「尾」段——同样回放（overlay 合成 after 段不掉色）
		expect(after.startsWith("\x1b[31m")).toBe(true);
		expect(stripAnsi(after)).toBe("尾");
	});
	it("⑪ OSC 8 链接态随回放带入：切点落在链接文本中间，切片仍是可点击链接", () => {
		const line = "前缀\x1b]8;;https://x.com/a\x07链接字\x1b]8;;\x07后缀";
		const mid = sliceByColumn(line, 6, 2); // 「接」字（链接开码在切点前 → pending 回放）
		expect(stripAnsi(mid)).toBe("接");
		expect(mid).toContain("\x1b]8;;https://x.com/a\x07"); // 起点前的链接开码随回放进切片
	});
});

describe("wrapText 幽灵行与末行收尾（CTW-07 回归钉 2026-09-28——断点空格被吞后 cur 只剩 SGR 前缀：零宽幽灵行 + 裸色串色）", () => {
	it("⑫ 尾随空格恰落断点且 ANSI 激活：不推零可见宽幽灵行（旧实现推出一条仅含 SGR 前缀的空行）", () => {
		// 「abcde」顶满 5 宽 → 空格触发折行且被吞 → 循环结束时 cur = "\x1b[31m\x1b[39m"（零可见宽）
		// 旧：["\x1b[31mabcde\x1b[0m", "\x1b[31m\x1b[39m"]（第二行幽灵——多一个视觉空行）
		expect(wrapText("\x1b[31mabcde \x1b[39m", 5)).toEqual(["\x1b[31mabcde\x1b[0m"]);
		expect(wrapText("abcde ", 5)).toEqual(["abcde"]); // 无色变体行为不变（旧也无幽灵）
	});
	it("⑬ 末行补 reset 收尾：与 emit() 同口径（旧末行裸推无收尾——非自闭合输入串色到下一逻辑行）", () => {
		const lines = wrapText("\x1b[31mabcdef", 5); // 裸色输入（无 39m 自闭合）
		expect(lines).toEqual(["\x1b[31mabcde\x1b[0m", "\x1b[31mf\x1b[0m"]); // 末行同补收尾
	});
});

describe("Unicode 属性计宽（2026-10-01 滚动条顶飞事故批——✅ 一行 N 个账面各少 1 列，行尾滚动条被顶出 N 列；八仓调研：pi RGI_Emoji/Reasonix \\p{Emoji_Presentation} 全处理、唯自建区间表漏 BMP 散点 emoji）", () => {
	it("⑭ emoji 呈现单字符宽 2（✅❌⭐ 本案主犯）；text 形态维持 ambiguous=1 政策（✓⚠）", () => {
		expect(visibleWidth("✅")).toBe(2); // U+2705——eawWide 区间表外、RGI basic emoji（旧：1 列 ← 顶飞根因）
		expect(visibleWidth("❌")).toBe(2); // U+274C
		expect(visibleWidth("⭐")).toBe(2); // U+2B50
		expect(visibleWidth("⏰")).toBe(2); // U+23F0（Misc technical 段）
		expect(visibleWidth("✓")).toBe(1); // U+2713 text 形态——Reasonix 注释点名验证过，政策不动
		expect(visibleWidth("⚠")).toBe(1); // U+26A0 默认 text 呈现（cc-haha：string-width 错报 2 的反面钉）
	});
	it("⑮ RGI emoji 序列整体宽 2：ZWJ 家族/旗帜对/键帽/肤色——逐码点累加会虚报 6~8 列", () => {
		expect(visibleWidth("👨‍👩‍👧")).toBe(2); // ZWJ 家族（旧：6——尾部成员各 +2 累加）
		expect(visibleWidth("🇨🇳")).toBe(2); // 旗帜 = regional indicator 对（旧：4）
		expect(visibleWidth("#️⃣")).toBe(2); // 键帽 = # + VS16 + 20E3
		expect(visibleWidth("👍🏽")).toBe(2); // 肤色修饰序列
		expect(visibleWidth("🏳️‍🌈")).toBe(2); // 彩虹旗 = 白旗+VS16+ZWJ+tag 串（VS 区全 \p{Mn} 零宽）
	});
	it("⑯ 零宽集属性化：组合记号跨文字（泰/天城文）+ SHY/BOM/ZWJ/孤立代理全零宽（旧表只盖希腊段 0300-036F）", () => {
		expect(visibleWidth("ที่")).toBe(1); // 泰文整串一个 cluster：基字符 1 格 + ี ่ 叠印零宽
		expect(visibleWidth("ที่ท")).toBe(2); // 两个 cluster（旧：记号各 +1 虚报 4）
		expect(visibleWidth("गि")).toBe(1); // 天城文：ग + ि(U+093F Mn)
		expect(visibleWidth("e\u0301")).toBe(1); // NFD 分解型 combining acute（拉丁组合记号）
		expect(visibleWidth("a\u00ADB")).toBe(2); // SHY 软连字符（\p{Cf}）不占格
		expect(visibleWidth("a\uFEFFb")).toBe(2); // BOM/ZWNBSP
		expect(visibleWidth("a\u200Db")).toBe(2); // ZWJ 裸用
	});
	it("⑰ 事故形态端到端：✅ 密集长行折行——每行账本 ≤ 目标宽（= 终端实画宽，滚动条列不再被顶）", () => {
		const row = "核验 loader.ts:32-43 ✅ trust.ts:68-86 ✅ fs/index.ts:5 ✅ ui.ts:9 ✅ core.ts:12 ✅";
		for (const l of wrapText(row, 10)) expect(visibleWidth(l)).toBeLessThanOrEqual(10); // 每行恒不超宽
		expect(visibleWidth(truncateToWidth("✅".repeat(10), 15) + " ")).toBe(15); // 截断+垫空格=恒宽 15（行尾滚动条列的地基）
		expect(visibleWidth(padToWidth("ab✅cd", 8))).toBe(8); // pad 恒宽（✅=2 计入账本）
	});
	it("⑱ VS16 政策不回归：☀️❤️✓️ 升 2、裸 ☀❤✓ 维持 1", () => {
		expect(visibleWidth("☀️")).toBe(2);
		expect(visibleWidth("☀")).toBe(1);
		expect(visibleWidth("❤️")).toBe(2); // U+2764+FE0F
		expect(visibleWidth("❤")).toBe(1);
		expect(visibleWidth("✓️")).toBe(2); // 非 RGI（2713 无 emoji 呈现）但 VS16 政策升 2——政策保留
	});
});
