import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createKeyParser, createModal } from "./keys.ts";

/** 测试内构造的可读流（非 TTY 分支 run 在触碰 input 前即拒绝，空实现即可）。 */
const fakeStream = (): Readable => new Readable({ read() {} });

describe("按键解析器（TUI 批 T0——raw-mode 基座）", () => {
  it("① 方向键/PageUp/PageDown/Enter/Backspace/Tab 序列 → 对应事件", () => {
    const p = createKeyParser({ escWindowMs: 0 });
    expect(p.feed(Buffer.from("\x1b[A\x1b[B\x1b[5~\x1b[6~\r\x7f\x08\t"))).toEqual([
      { type: "arrow", dir: "up" }, { type: "arrow", dir: "down" },
      { type: "page", dir: "up" }, { type: "page", dir: "down" },
      { type: "enter" }, { type: "backspace" }, { type: "backspace" }, { type: "tab" },
    ]);
  });
  it("② \\x1b+v 单 chunk 到达 → meta v（Alt+V）；30ms 窗口后无续 → 单 esc", () => {
    const p = createKeyParser({ escWindowMs: 0 });
    expect(p.feed(Buffer.from("\x1bv"))).toEqual([{ type: "meta", ch: "v" }]);
    const q = createKeyParser({ escWindowMs: 0 });
    expect([...q.feed(Buffer.from("\x1b")), ...q.settle()]).toEqual([{ type: "esc" }]);
  });
  it("③ 跨 chunk 拆分的方向键（\\x1b 与 [A 分两包）→ 仍解析为 up", () => {
    const p = createKeyParser({ escWindowMs: 1000 });
    expect(p.feed(Buffer.from("\x1b"))).toEqual([]);
    expect(p.feed(Buffer.from("[A"))).toEqual([{ type: "arrow", dir: "up" }]);
  });
  it("④ 可打印字符成串 → 逐字符 char 事件", () => {
    const p = createKeyParser({ escWindowMs: 0 });
    expect(p.feed(Buffer.from("ab12"))).toEqual([
      { type: "char", ch: "a" }, { type: "char", ch: "b" },
      { type: "char", ch: "1" }, { type: "char", ch: "2" },
    ]);
  });
  it("⑤ CJK 多字节（中文整字符按码点拼装）→ 单个 char 事件", () => {
    const p = createKeyParser({ escWindowMs: 0 });
    expect(p.feed(Buffer.from("中"))).toEqual([{ type: "char", ch: "中" }]);
  });
  it("⑥ modal 非 TTY → run 直接抛 D35 同款拒绝式", async () => {
    const m = createModal({ input: fakeStream(), isTTY: false, write: () => {} });
    await expect(m.run(async () => "ok")).rejects.toThrow("无交互环境");
  });
});
