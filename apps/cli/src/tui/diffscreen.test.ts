import { describe, it, expect } from "vitest";
import { DiffScreen } from "./diffscreen.ts";
import { visibleWidth } from "./width.ts";

/** 收集写出帧。 */
const rig = () => {
	const frames: string[] = [];
	const d = new DiffScreen((s) => frames.push(s));
	return { d, frames };
};

/** 迷你终端模拟器（CTW-01/CTW-02 回归钉）：只实现 DiffScreen 会发出的序列——光标上/下移（CUU/CUD）、
 *  CR/LF、整行清除（EL 2K）、清屏归位（ED 2J + CUP H + 3J）与同步输出开关（?2026 h/l 不动网格）。
 *  断言用终端网格终态而非转义字节计数——CTW-01 漏检教训：只数 \x1b[2K 次数时记账漂移照样绿。 */
// 终端断言合法形态：解析 ANSI 控制序列必须匹配 ESC（lint 基线批定点豁免）
// oxlint-disable-next-line no-control-regex
const CSI = /\x1b\[(\??)(\d*)([A-Za-z])/y;
const term = () => {
	const rows: string[] = [""];
	let row = 0;
	return {
		feed(data: string): void {
			let i = 0;
			while (i < data.length) {
				const ch = data[i]!;
				if (ch === "\x1b") {
					CSI.lastIndex = i;
					const m = CSI.exec(data);
					if (m === null) {
						i++;
						continue;
					}
					const n = m[2] === "" ? 1 : Number(m[2]);
					if (m[3] === "A") row = Math.max(0, row - n);
					else if (m[3] === "B") row += n;
					else if (m[3] === "K") rows[row] = ""; // DiffScreen 只发 2K（整行清）
					else if (m[3] === "J" && m[2] === "2") {
						rows.length = 1;
						rows[0] = "";
						row = 0;
					} else if (m[3] === "H") row = 0;
					// 3J（清滚动回退）与 h/l（?2026 同步输出开关）不影响网格
					while (rows.length <= row) rows.push("");
					i = CSI.lastIndex;
					continue;
				}
				if (ch === "\r") {
					i++;
					continue;
				} // 写行前必有 2K 或行本空——追加模型成立
				if (ch === "\n") {
					row++;
					while (rows.length <= row) rows.push("");
					i++;
					continue;
				}
				if (ch === "\x07") {
					i++;
					continue;
				} // OSC 终止符（DiffScreen 不产 OSC，防御性跳过）
				rows[row] += ch;
				i++;
			}
		},
		rows: (): string[] => [...rows],
	};
};

/** 无孤立代理：每个 UTF-16 代理码元必须与配对半区相邻（CTW-02 码元切片劈代理对的钉）。 */
const noOrphan = (s: string): boolean => {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0xd800 || c > 0xdfff) continue;
		const hi = c <= 0xdbff;
		const other = s.charCodeAt(hi ? i + 1 : i - 1); // 越界得 NaN → 配对失败
		const ok = hi ? other >= 0xdc00 && other <= 0xdfff : other >= 0xd800 && other <= 0xdbff;
		if (!ok) return false;
	}
	return true;
};

describe("滚动流渲染器（TUI 批阶段三 F0——行级 diff + append 快路径）", () => {
	it("① 首帧全量 + 纯追加只写尾部（append 快路径，不重写已有行）", () => {
		const { d, frames } = rig();
		d.render(["a", "b"], 80);
		d.render(["a", "b", "c"], 80);
		expect(frames[0]).toContain("a");
		expect(frames[0]).toContain("b");
		expect(frames[1]).toContain("c");
		expect(frames[1]).not.toContain("\x1b[2Ka"); // 不重写 a 行
		expect(frames[1]).not.toContain("\x1b[2Kb"); // 不重写 b 行
		expect(frames[1]).toContain("\x1b[?2026h"); // 同步输出包裹
	});
	it("② 中间行变化只重写变化区间（上移 N 行 + 逐行清，未变行不出现）", () => {
		const { d, frames } = rig();
		d.render(["a", "b", "c"], 80);
		d.render(["a", "B", "c"], 80);
		const f = frames[1]!;
		expect(f).toContain("\x1b[1A"); // 上移 1 行回到 b 行
		expect(f).toContain("\x1b[2KB"); // 清行重写为 B
		expect(f).not.toContain("\x1b[2Ka");
		expect(f).not.toContain("\x1b[2Kc");
	});
	it("③ 行数收缩：多余旧行清除（CTW-01——纯前缀收缩首条残留行漏清 + cursorRow 漂移，改钉终端网格终态）", () => {
		const { d, frames } = rig();
		const t = term();
		d.render(["a", "b", "c", "d"], 80);
		d.render(["a", "b"], 80); // 纯前缀收缩：写循环零迭代——旧实现首条残留行 "c" 不清、cursorRow 差一行
		d.render(["a", "b", "x"], 80); // 再追加——旧实现 "x" 落在漂移基线下一行、"c" 永久夹在 b 与 x 之间
		for (const f of frames) t.feed(f);
		// 断言更新注明（CTW-01）：原断言只数 \x1b[2K 出现次数（>=2），网格残留时照样绿——
		// 按报告建议改断终端终态：三帧序列后网格恰为新帧内容 + 已清空行，无残留
		expect(t.rows()).toEqual(["a", "b", "x", ""]);
	});
	it("④ 宽度变化 → 全量重绘（清屏 + 清滚动回退 \\x1b[3J）", () => {
		const { d, frames } = rig();
		d.render(["a", "b"], 80);
		d.render(["a", "b"], 60);
		const f = frames[1]!;
		expect(f).toContain("\x1b[2J\x1b[H\x1b[3J");
		// 宽度不变 → 零帧
		d.render(["a", "b"], 60);
		expect(frames).toHaveLength(2);
	});
	it("⑤ CTW-02 超宽行按显示列截断：「中」×40 在 20 列宽下渲染每行 ≤20 显示列（原码元 slice 切 20 码元 = 40 列不收敛）", () => {
		const { d, frames } = rig();
		const t = term();
		const cjk = "中".repeat(40); // 显示宽 80，超出 20 列
		// 逐帧断言（末帧全量重写会把超宽行覆盖掉——只看终态抓不到中间帧的旧 bug）
		d.render([cjk], 20); // 首帧写行路径
		t.feed(frames[0]!);
		expect(t.rows().map(visibleWidth).every((w) => w <= 20)).toBe(true);
		d.render([cjk, cjk], 20); // 追加路径（append 快路径写行同样过守卫）
		t.feed(frames[1]!);
		expect(t.rows().map(visibleWidth).every((w) => w <= 20)).toBe(true);
		d.render(["a", "b"], 20); // 收缩路径（变化区间重写）
		t.feed(frames[2]!);
		expect(t.rows().map(visibleWidth).every((w) => w <= 20)).toBe(true);
	});
	it("⑥ CTW-02 宽度变化全量重绘同样有宽度守卫 + 截断不劈代理对：emoji 串 80 列 → 20 列重绘后 ≤20 列且无孤立代理", () => {
		const { d, frames } = rig();
		const t = term();
		const emoji = "😀".repeat(30); // 显示宽 60——原码元 slice 按码元数切，可劈在代理对中间
		d.render([emoji], 9); // 首帧窄宽截断
		d.render([emoji], 20); // 宽度变化 → 全量重绘路径（原实现原样写出 60 列）
		for (const f of frames) t.feed(f);
		expect(t.rows()).toHaveLength(1);
		const row = t.rows()[0]!;
		expect(visibleWidth(row)).toBeLessThanOrEqual(20);
		expect(noOrphan(row)).toBe(true);
	});
	it("⑦ CTW-11 收缩到空帧：第 0 行残留清净 + 空帧不再被当首帧哨兵（旧下一帧无定位直写 → \"xbcdefgh\" 永久残留）", () => {
		const { d, frames } = rig();
		const t = term();
		d.render(["abcdefgh"], 80);
		d.render([], 80); // 收缩到完全空——旧实现「先 \r\n 再清」漏掉第 0 行、cursorRow 记到 -1
		d.render(["x"], 80); // 空帧后再渲染——旧实现 previousLines.length===0 误判首帧、直写覆在残留行上
		for (const f of frames) t.feed(f);
		expect(t.rows()).toEqual(["x"]); // 旧终态：["xbcdefgh"]
	});
	it("⑧ CTW-11 多行帧收缩到空帧：全行清净（含第 0 行）、后续帧不再错位——不借多下移一行凑数（帧底 \\r\n 会触发终端滚动）", () => {
		const { d, frames } = rig();
		const t = term();
		d.render(["a", "b", "c"], 80);
		d.render([], 80);
		d.render(["x"], 80);
		d.render(["x", "y"], 80); // 空帧恢复后再追加——基线（cursorRow）正确才不出错行
		for (const f of frames) t.feed(f);
		expect(t.rows()).toEqual(["x", "y", ""]); // 旧终态：["xa", "y", ""]——第 0 行 "a" 漏清、"x" 覆写其上（"bc" 已清净、错位不再扩大）
	});
});
