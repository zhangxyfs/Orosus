import { describe, it, expect } from "vitest";
import { LiveWrap } from "./live-wrap.ts";
import { wrapText } from "./width.ts";

/** 确定性伪随机（LCG）——等价性质测试 200 轮须可复现，禁 Math.random 防 flaky。 */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

/** 随机中英混排行（覆盖多行/超宽/空行/词原子边界：URL、标识符、CJK 禁则字、emoji、ANSI 色码）。 */
function randomText(rng: () => number): string {
	const words = ["check:boundaries", "https://example.com/a/b?c=d", "生成物diff", "名字（长URL）", "❤️", "裸色\x1b[31m红\x1b[0m尾", "TUI", "流式渲染", "（）「」【】、。…—", "abc_def-123", ""];
	const nLines = 1 + Math.floor(rng() * 12);
	const lines: string[] = [];
	for (let i = 0; i < nLines; i++) {
		if (rng() < 0.15) {
			lines.push(""); // 空行
			continue;
		}
		const nWords = 1 + Math.floor(rng() * 14);
		const parts: string[] = [];
		for (let j = 0; j < nWords; j++) parts.push(words[Math.floor(rng() * words.length)]!);
		lines.push(parts.join(rng() < 0.5 ? " " : ""));
	}
	return lines.join("\n");
}

describe("LiveWrap 增量折行（m5-render-perf T0——codex live_wrap.rs 同构）", () => {
	it("① 等价性质：随机中英混排 200 轮——逐块随机切分喂入，每步输出 == 该时刻全量 wrapText（逐字节）", () => {
		const rng = lcg(20260929);
		for (let round = 0; round < 200; round++) {
			const text = randomText(rng);
			const width = 4 + Math.floor(rng() * 40); // 4-43：超宽与不超宽都覆盖
			// 随机切分：按随机字符段切成块（可能劈开多字节字符的前半——按 UTF-16 码元切，与真实流式 delta 同形态）
			const chunks: string[] = [];
			let pos = 0;
			while (pos < text.length) {
				const len = 1 + Math.floor(rng() * 17);
				chunks.push(text.slice(pos, pos + len));
				pos += len;
			}
			const lw = new LiveWrap();
			let acc = "";
			for (const c of chunks) {
				acc += c;
				const got = lw.feed(acc, width);
				const want = wrapText(acc, width);
				expect(got, `round=${round} acc="${acc.slice(0, 40)}" width=${width}`).toEqual(want);
			}
			// 同文本再喂一遍（稳态重复帧）：结果不变
			expect(lw.feed(acc, width)).toEqual(wrapText(acc, width));
		}
	});

	it("② 宽度变化 = 新宽一次性全量重折（D8 同语义的 LiveWrap 侧：清缓存整体重折一次）", () => {
		const lw = new LiveWrap();
		const text = "一句话很短的行以及另一段比较长的中文内容用来触发折行逻辑的边界情况";
		lw.feed(text, 60);
		const out = lw.feed(text, 12); // 宽度收窄
		expect(out).toEqual(wrapText(text, 12));
		for (const l of out) expect(l.includes("。")).toBe(false); // 新宽下真折了（非旧宽结果的直线）
		// 再加宽回去
		expect(lw.feed(text, 60)).toEqual(wrapText(text, 60));
	});

	it("③ 前缀回退正确重建：改写中段与回缩文本都按当前文本全量重折（startsWith 防御——md/streaming.ts 同款）", () => {
		const lw = new LiveWrap();
		lw.feed("abcdef\nxy 一段", 30);
		expect(lw.feed("abQQQ\nxy 一段", 30)).toEqual(wrapText("abQQQ\nxy 一段", 30)); // 中段改写
		lw.feed("abcdef\nxy", 30);
		expect(lw.feed("abc", 30)).toEqual(wrapText("abc", 30)); // 回缩（更短）
		lw.feed("abcdef\nxy", 30);
		expect(lw.feed("abcdef\nxy 再加长", 30)).toEqual(wrapText("abcdef\nxy 再加长", 30)); // 回缩后正常续长
	});

	it("④ 空文本与纯换行边界", () => {
		const lw = new LiveWrap();
		expect(lw.feed("", 20)).toEqual(wrapText("", 20)); // [""]
		expect(lw.feed("\n", 20)).toEqual(wrapText("\n", 20));
		expect(lw.feed("\n\n\n", 20)).toEqual(wrapText("\n\n\n", 20));
		const lw2 = new LiveWrap();
		lw2.feed("abc", 20);
		expect(lw2.feed("", 20)).toEqual(wrapText("", 20)); // 有缓存后喂空 = 回缩重建
	});

	it("⑤ 已完成行不被尾部追加改写：后续 feed 只影响尾行（增量缓存的核心不变量）", () => {
		const lw = new LiveWrap();
		lw.feed("第一行完成\n第二行完成\n尾行", 30);
		const r1 = lw.feed("第一行完成\n第二行完成\n尾行", 30);
		const r2 = lw.feed("第一行完成\n第二行完成\n尾行继续生长", 30);
		// r1 = ["第一行完成","第二行完成","尾行"]——前两行（已完成）逐字节不动
		expect(r2[0]).toBe(r1[0]);
		expect(r2[1]).toBe(r1[1]);
		expect(r1[0]).toBe("第一行完成");
		expect(r2.join("")).toContain("尾行继续生长");
	});

	it("⑥ 极端单根行 5KB 不封顶：分片喂入与一次喂入产出一致（D7 钉边界记录现状）", () => {
		const line = "无换行超长行内容".repeat(640); // ~5KB（UTF-16 码元 3840，显示宽 7680）
		const width = 30;
		const lw = new LiveWrap();
		let acc = "";
		for (let i = 0; i < line.length; i += 300) {
			acc = line.slice(0, i + 300);
			const got = lw.feed(acc, width);
			expect(got).toEqual(wrapText(acc, width));
		}
		expect(lw.feed(line, width)).toEqual(wrapText(line, width));
	});

	it("⑦ lastFeedWrappedChars：初值 0；首次 feed = 全文字符数；同文本重复 feed = 尾行字符数（稳态）", () => {
		const lw = new LiveWrap();
		expect(lw.lastFeedWrappedChars).toBe(0);
		lw.feed("hello\nworld 尾", 40);
		expect(lw.lastFeedWrappedChars).toBe(5 + 7); // 两个逻辑行都折了（"hello" + "world 尾"）
		lw.feed("hello\nworld 尾", 40);
		expect(lw.lastFeedWrappedChars).toBe(7); // 已完成行命中缓存，仅尾行现折
		lw.feed("hello\nworld 尾!", 40);
		expect(lw.lastFeedWrappedChars).toBe(8); // 追加 1 字符：仍只折尾行
	});
});
