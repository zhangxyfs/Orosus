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

  it("⑦ 模态接管自开 raw 模式并在退出时恢复（T8 走查实锤回归：cooked 控制台自吞方向键）", async () => {
    // TTY 流替身：Readable + setRawMode/isRaw 模拟（真实路径 process.stdin——tty.ReadStream）
    const rawCalls: boolean[] = [];
    const mkTty = (initialRaw: boolean): Readable & { setRawMode(m: boolean): void; isRaw: boolean } => {
      const s = fakeStream() as Readable & { setRawMode(m: boolean): void; isRaw: boolean };
      s.isRaw = initialRaw;
      s.setRawMode = (m: boolean): void => { rawCalls.push(m); s.isRaw = m; };
      return s;
    };
    // 挂起中恢复：流入关闭 → readKey 以 esc 冲刷返回 → fn 走完 → finally 恢复接管前状态（false）
    const input1 = mkTty(false);
    const m1 = createModal({ input: input1, isTTY: true, write: () => {} });
    const p1 = m1.run(async (readKey) => {
      const k = await readKey();
      return k.type;
    });
    await new Promise((r) => setTimeout(r, 20)); // 让 run 完成接管
    input1.destroy(); // 触发 close → 挂起的 readKey 冲刷为 esc
    await expect(p1).resolves.toBe("esc");
    expect(rawCalls).toEqual([true, false]);
    // 接管前已是 raw → 失败路径同样恢复 true（finally，不扰宿主 readline 的原始态管理）
    rawCalls.length = 0;
    const m2 = createModal({ input: mkTty(true), isTTY: true, write: () => {} });
    await expect(m2.run(async () => { throw new Error("fn 失败"); })).rejects.toThrow("fn 失败");
    expect(rawCalls).toEqual([true, true]);
    // 无 setRawMode 的假流（既有用例形态）→ 不炸
    const m3 = createModal({ input: fakeStream(), isTTY: true, write: () => {} });
    await expect(m3.run(async () => "ok")).resolves.toBe("ok");
  });

  it("⑧ 模态接管摘除流的 keypress 监听并在退出时原样装回（T8 走查实锤 BUG C 回归）", async () => {
    // 真实链条：字节 → emitKeypressEvents 合成器 → 'keypress' 事件 → readline _ttyWrite。
    // readable 拉取停不掉这条路（winpty/conhost 实测：方向键 keypress 模态中照发，↑ 触发历史
    // 召回把上一条命令整行写回 rl.line）——接管即摘下全部 keypress 监听，退出原样装回。
    const input = fakeStream();
    const hits: string[] = [];
    const recA = (s: string): void => { hits.push(`A${s}`); };
    const recB = (s: string): void => { hits.push(`B${s}`); };
    input.on("keypress", recA); // readline 行编辑替身
    input.on("keypress", recB); // Alt+V 挂钩替身
    input.emit("keypress", "x"); // 接管前：监听在档
    expect(hits).toEqual(["Ax", "Bx"]);
    const m = createModal({ input, isTTY: true, write: () => {} });
    const done = m.run(async () => {
      expect(input.listeners("keypress")).toEqual([]); // 接管中：全摘（合成器空转无害）
      input.emit("keypress", "y");
      expect(hits).toEqual(["Ax", "Bx"]); // 模态中合成的事件无人消费
      return "ok";
    });
    await expect(done).resolves.toBe("ok");
    expect(input.listeners("keypress")).toEqual([recA, recB]); // 退出：原样装回（序保持）
    input.emit("keypress", "z");
    expect(hits).toEqual(["Ax", "Bx", "Az", "Bz"]); // 宿主键处理复活
  });
});
