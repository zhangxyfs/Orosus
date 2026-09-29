/** 活动块按逻辑行增量折行缓存（m5-render-perf T0——codex live_wrap.rs 同构）。
 *  依据：wrapText 按逻辑行独立（width.ts:160 split 在前、AnsiTracker 每行新建），
 *  已完成行折一次进缓存，每帧只折最后一条未完行——产出与全量 wrapText 逐字节相等。
 *  缓存裸行不着色（D4：Alt+E 收起/展开两态样式不同，裸行一份缓存两态共用；上色是拼接
 *  便宜、折行是逐字符计宽贵——贵的进缓存便宜的现做）；键 = 宽度；文本回缩（startsWith
 *  不匹配）全量重建（md/streaming.ts frozenText 同款防御）。 */

import { wrapText } from "./width.ts";

export class LiveWrap {
	/** 最近一次 feed 实际折行的源字符数（性能钉数据源——设计空白 #3：稳态 = 尾行长度；
	 *  改回全量重折则 = 全文长度，回归钉以此为断言口）。 */
	lastFeedWrappedChars = 0;
	private w = -1;
	private done: string[] = []; // 已完成逻辑行的折行结果（扁平追加，永不重折）
	private consumed = 0; // 已固化进 done 的前缀长度（恒对齐到最后一个 \n 之后）
	private prefix = ""; // 上一帧文本快照（引用不拷贝——回缩/改写检测）

	/** 喂入全量累积文本，返回全场裸物理行（已完成行出缓存 + 尾行现折）。
	 *  width = 折行宽（调用方算好传入——两处消费点现状均 Math.max(8, w - 2)）。 */
	feed(text: string, width: number): string[] {
		if (width !== this.w || !text.startsWith(this.prefix)) {
			// 宽度变化 / 文本回缩改写：清缓存整体重折（等价旧路径一帧成本，一次性）
			this.w = width;
			this.done = [];
			this.consumed = 0;
			this.prefix = "";
		}
		let wrapped = 0;
		for (;;) {
			const nl = text.indexOf("\n", this.consumed);
			if (nl === -1) break;
			const line = text.substring(this.consumed, nl);
			this.done.push(...wrapText(line, width));
			wrapped += line.length;
			this.consumed = nl + 1;
		}
		const tail = text.substring(this.consumed);
		const tailLines = wrapText(tail, width);
		this.lastFeedWrappedChars = wrapped + tail.length;
		this.prefix = text;
		const out = this.done.slice(); // 浅拷贝护缓存：消费方上色/map 不改 done（O(行数) 引用拷贝）
		out.push(...tailLines);
		return out;
	}
}
