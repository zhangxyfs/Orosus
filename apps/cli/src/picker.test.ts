import { describe, it, expect } from "vitest";
import { createKeyParser, type KeyEvent } from "./keys.ts";
import { pick } from "./picker.ts";

describe("键盘菜单 picker（TUI 批 T1——B5 第 2 层）", () => {
  const fakeIo = (keys: string[], w: string[] = []) => {
    // parseOnce = createKeyParser 单例的 feed 包装（逐键喂给 T0 解析器）
    const parser = createKeyParser({ escWindowMs: 0 });
    const parseOnce = (seq: string): KeyEvent => {
      const evs = [...parser.feed(Buffer.from(seq)), ...parser.settle()];
      const ev = evs[0];
      if (ev === undefined) throw new Error(`序列无事件: ${JSON.stringify(seq)}`);
      return ev;
    };
    return {
      isTTY: true,
      runModal: async <T,>(fn: (rk: () => Promise<KeyEvent>) => Promise<T>): Promise<T> => {
        let i = 0;
        return fn(async () => parseOnce(keys[i++] ?? "\r"));
      },
      write: (s: string) => {
        w.push(s);
      },
      numberQuestion: async () => {
        throw new Error("不应走回落");
      },
    };
  };
  it("① 初始渲染首项高亮；下→上→回车返回正确下标", async () => {
    const io = fakeIo(["\x1b[B", "\x1b[A", "\r"]);
    expect(await pick(["甲", "乙", "丙"], io)).toBe(0);
  });
  it("② 反色转义包裹当前项（\\x1b[7m … \\x1b[27m）", async () => {
    const w: string[] = [];
    const io = fakeIo(["\r"], w);
    await pick(["a", "b"], io);
    expect(w.join("")).toContain("\x1b[7ma\x1b[27m");
  });
  it("③ Esc → 抛「已取消（Esc）」（menu 侧映射前的原始约定：pick 以 reject 表达）", async () => {
    await expect(pick(["a"], fakeIo(["\x1b"]))).rejects.toThrow("已取消");
  });
  it("④ 数字直达：按 2 直接选中第二项", async () => {
    expect(await pick(["a", "b", "c"], fakeIo(["2"]))).toBe(1);
  });
  it("⑤ 非 TTY → 回落现状编号版（numberQuestion 路径）", async () => {
    const io = { ...fakeIo(["\r"]), isTTY: false, numberQuestion: async () => "1" };
    expect(await pick(["a", "b"], io)).toBe(0);
  });
  it("⑥ 超 9 项不数字直达（两位数字会与导航冲突——与设计空白「≤9 项数字直达」同口径）——数字键被忽略、仍导航", async () => {
    const items = Array.from({ length: 12 }, (_, i) => `i${i}`);
    expect(await pick(items, fakeIo(["1", "\x1b[B", "\r"]))).toBe(1);
  });
});
