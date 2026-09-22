import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTuiMode, formatBytes, dirUsage } from "./tuicfg.ts";

describe("TUI 设置（F6——模式解析优先级 + 磁盘占用）", () => {
	it("① resolveTuiMode：--tui 旗标 > 配置 > TTY 缺省；非法配置值按未配置", () => {
		expect(resolveTuiMode("line", "full", true)).toBe("line"); // 旗标压配置
		expect(resolveTuiMode("full", "line", false)).toBe("full");
		expect(resolveTuiMode(undefined, "line", true)).toBe("line"); // 配置生效
		expect(resolveTuiMode(undefined, "full", false)).toBe("full"); // 配置压 TTY 缺省
		expect(resolveTuiMode(undefined, undefined, true)).toBe("full"); // 缺省 TTY=full
		expect(resolveTuiMode(undefined, undefined, false)).toBe("line"); // 非 TTY=line
		expect(resolveTuiMode(undefined, "bogus", true)).toBe("full"); // 非法值按未配置
		expect(resolveTuiMode(undefined, "", false)).toBe("line");
	});

	it("② formatBytes 阶梯", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
		expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
	});

	it("③ dirUsage：递归求和 + 文件计数；缺失目录零值不炸", () => {
		const d = mkdtempSync(join(tmpdir(), "orosus-tuicfg-"));
		try {
			mkdirSync(join(d, "sub"));
			writeFileSync(join(d, "a.txt"), "x".repeat(100));
			writeFileSync(join(d, "sub", "b.txt"), "y".repeat(50));
			const u = dirUsage(d);
			expect(u).toEqual({ bytes: 150, files: 2 });
			expect(dirUsage(join(d, "nope"))).toEqual({ bytes: 0, files: 0 });
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
