/** m5-update-check 走查修：refs 未注入窗口期防御钉——子命令读 stdin 首例（orosus upgrade 确认，
 *  2026-10-07 真机实锚 yy 崩栈）。模块体建 rl 早于 initReplIo 是既有时序，此前无人读 stdin 故未炸。 */
import { describe, it, expect } from "vitest";
import { rl } from "./repl-io.ts";

describe("refs 未注入窗口期（子命令读 stdin）", () => {
	it("line 事件不炸（丢弃不排队）", () => {
		expect(() => rl.emit("line", "yy")).not.toThrow();
		expect(() => rl.emit("line", "")).not.toThrow();
	});
});
