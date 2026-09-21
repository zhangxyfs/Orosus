/** 组件接口与帧调度器（TUI 批阶段三 F0——pi-tui tui.ts TuiBase 精简移植，spike 验证件）。
 *  蓝本：pi `tui.ts` Component(:111-117) + MIN_RENDER_INTERVAL_MS(:477) +
 *  requestImmediateRender(:963-978) + 键盘抢占(:1078-1081)。
 *  抄取：Component { render(width): string[] } 即时模式（行数组即 framebuffer）；
 *  16ms 最小帧间隔调度（流式期间合帧）；**键盘输入抢占**——requestImmediateRender 走
 *  nextTick 并取消待发节流帧（Windows 定时器粒度不可靠，setTimeout(0) 可达 16ms 整刻度，
 *  spike 实测抢占时延 P95 2.8ms）。 */

export interface Component {
	render(width: number): string[];
	handleInput?(key: string): void;
	invalidate?(): void;
}

export interface FrameSample {
	at: number; // 帧写出时刻（performance.now）
	ms: number; // 本帧渲染耗时（doRender 墙钟）
	bytes: number; // 本帧写出字节数
	reason: "immediate" | "throttled" | "force";
}

export class FrameScheduler {
	private renderRequested = false;
	private immediateScheduled = false;
	private timer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	static readonly MIN_RENDER_INTERVAL_MS = 16;
	private stopped = false;
	private doRender: (reason: FrameSample["reason"]) => number;

	/** 帧采样回调（bench 打点用——帧间隔 P95 判据的数据源）。 */
	onFrame?: (sample: FrameSample) => void;

	constructor(doRender: (reason: FrameSample["reason"]) => number) {
		this.doRender = doRender;
	}

	requestRender(): void {
		if (this.renderRequested || this.stopped) return;
		this.renderRequested = true;
		process.nextTick(() => this.schedule());
	}

	/** 键盘输入抢占：取消待发节流帧，nextTick 立即渲染（pi 同构）。 */
	requestImmediateRender(): void {
		if (this.stopped) return;
		this.renderRequested = true;
		if (this.immediateScheduled) return;
		this.immediateScheduled = true;
		process.nextTick(() => {
			this.immediateScheduled = false;
			if (this.stopped || !this.renderRequested) return;
			this.cancelTimer();
			this.renderRequested = false;
			const t0 = performance.now();
			const bytes = this.doRender("immediate");
			const t1 = performance.now();
			this.lastRenderAt = t1;
			this.onFrame?.({ at: t1, ms: t1 - t0, bytes, reason: "immediate" });
		});
	}

	private cancelTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private schedule(): void {
		if (this.stopped || this.timer || !this.renderRequested) return;
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, FrameScheduler.MIN_RENDER_INTERVAL_MS - elapsed);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.stopped || !this.renderRequested) return;
			this.renderRequested = false;
			const t0 = performance.now();
			const bytes = this.doRender("throttled");
			const t1 = performance.now();
			this.lastRenderAt = t1;
			this.onFrame?.({ at: t1, ms: t1 - t0, bytes, reason: "throttled" });
			if (this.renderRequested) this.schedule();
		}, delay);
		this.timer.unref?.();
	}

	stop(): void {
		this.stopped = true;
		this.cancelTimer();
	}
}
