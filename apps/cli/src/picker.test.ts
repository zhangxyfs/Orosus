import { describe, it, expect } from "vitest";
import { createKeyParser, type KeyEvent } from "./keys.ts";
import { pick, pickLabel, viewportOf } from "./picker.ts";
import { fg, dim } from "./theme.ts";
import { stripAnsi } from "./tui/width.ts";

/** 测试夹具（T1/T2 共用）：keys 逐条喂给 T0 解析器（parseOnce = createKeyParser 单例的 feed 包装），
 *  按键耗尽后按回车兜底；w 收集全部写面输出供渲染断言。 */
const fakeIo = (keys: string[], w: string[] = []) => {
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

describe("键盘菜单 picker（TUI 批 T1——B5 第 2 层）", () => {
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
  it("④b 当前值项（「 ✓」尾标）染青玉 accent、普通项素色（2026-09-25 用户拍板——与全屏 choose 浮层同形）", async () => {
    const w: string[] = [];
    await pick(["low", "high ✓", "max"], fakeIo(["\r"], w));
    const out = w.join("");
    expect(out).toContain(fg("accent", "high ✓"));
    expect(out).not.toContain(fg("accent", "low"));
    expect(out).toContain("\x1b[7m"); // 光标行反色高亮原样（reverse 包裹彩色项共存）
  });
  it("⑤ 非 TTY → 回落现状编号版（numberQuestion 路径）", async () => {
    const io = { ...fakeIo(["\r"]), isTTY: false, numberQuestion: async () => "1" };
    expect(await pick(["a", "b"], io)).toBe(0);
  });
  it("⑥ 超 9 项不数字直达（两位数字会与导航冲突——与设计空白「≤9 项数字直达」同口径）——数字键被忽略、仍导航", async () => {
    const items = Array.from({ length: 12 }, (_, i) => `i${i}`);
    expect(await pick(items, fakeIo(["1", "\x1b[B", "\r"]))).toBe(1);
  });
  it("⑦ 两段式渲染（2026-09-28 用户拍板——与斜杠主菜单/全屏 choose 同形）：标题白、说明灰", async () => {
    const w: string[] = [];
    await pick(["磁盘占用（各目录大小与清理口径）", "需要时候询问——有问题就先问用户"], fakeIo(["\r"], w));
    const out = w.join("");
    expect(out).toContain(`磁盘占用${dim("（各目录大小与清理口径）")}`);
    expect(out).toContain(`需要时候询问 ${dim("——有问题就先问用户")}`);
    expect(stripAnsi(out)).toContain("磁盘占用（各目录大小与清理口径）"); // 可见形态不变
  });
  it("⑧ pickLabel 拆分边界：多行项/括注让位/✓ 与说明并存/纯标题与已着色行原样", () => {
    expect(pickLabel("name\n（https://api.kimi.com/coding/v1）")).toBe(`name ${dim("（https://api.kimi.com/coding/v1）")}`);
    expect(pickLabel("技能（查看 / 启停——四轨目录全部技能）")).toBe(`技能${dim("（查看 / 启停——四轨目录全部技能）")}`); // —— 在括注组内归说明
    expect(pickLabel("每次都询问——有问题就先问用户 ✓")).toBe(`${fg("accent", "每次都询问")} ${dim("——有问题就先问用户")} ${fg("accent", "✓")}`);
    expect(pickLabel("high ✓")).toBe(fg("accent", "high ✓")); // 纯标题当前项整项青玉（拍板原样）
    expect(pickLabel("[取消]")).toBe("[取消]"); // 纯标题不动
    expect(pickLabel(`\x1b[2m已着色行\x1b[22m`)).toBe(`\x1b[2m已着色行\x1b[22m`); // 调用方自拼样式的行原样
  });
  // CR-05 回归钉：空表 TTY 回车返回 0/方向环绕 (0-1+0)%0=NaN 都是伪装合法下标（items[NaN]
  // → undefined 落给调用方）；非 TTY 编号回落 `n <= 0` 永假 → 无限重问挂死脚本/CI
  it("⑨ CR-05 空表：TTY/非 TTY 均显式拒绝「无可选项」——不再返回 NaN/0 假下标、不再死循环", async () => {
    await expect(pick([], fakeIo(["\r"]))).rejects.toThrow("无可选项"); // 旧版回车返回 0（items[0] 伪装合法）
    await expect(pick([], { ...fakeIo(["\r"]), isTTY: false, numberQuestion: async () => "1" })).rejects.toThrow("无可选项"); // 旧版在此无限重问
  });
  // CR-06 回归钉：重绘 moveUp 的 N 必须按视觉行数（ansi.ts 头注硬约定）——CJK 双宽使超宽行
  // 折成多个物理行，按逻辑行数 lines.length 少移 → 每次导航错位一行 + 折行残影
  it("⑩ CR-06 视觉行数口径：折行帧的重绘上移按视觉行数（\\x1b[5A——m5-i18n T6 整句脚注后 5 视觉行）", async () => {
    const w: string[] = [];
    // 20 列窄终端：两项各 1 视觉行，提示句 57 显示宽 > 20 → 折 3 行（m5-i18n T6 整句键后更宽）；
    // 逻辑 3 行 / 视觉 5 行——下键导航后的重绘 moveUp 必须上移 5 行（少移 → 残影）
    await pick(["菜单甲项一", "菜单乙项二"], { ...fakeIo(["\x1b[B", "\r"], w), columns: 20 });
    const out = w.join("");
    expect(out).toContain("\x1b[5A");
    expect(out).not.toContain("\x1b[4A");
  });
});

describe("滚动窗口（TUI 批 T2——B5 厂商目录分页）", () => {
  it("① viewportOf：选中项下移越界 → 窗口跟随滚动", () => {
    expect(viewportOf(221, 0, 15)).toEqual({ start: 0, end: 15 });
    expect(viewportOf(221, 15, 15)).toEqual({ start: 1, end: 16 }); // 第 16 项滚入
    expect(viewportOf(221, 220, 15)).toEqual({ start: 206, end: 221 }); // 尾项贴底
  });
  it("② PageDown 整窗下移一屏、末窗贴底不越界", async () => {
    const items = Array.from({ length: 40 }, (_, i) => `v${i}`);
    expect(await pick(items, { ...fakeIo(["\x1b[6~", "\r"]), height: 10 })).toBe(10); // 首项变第 11 项（height 在 io 内——与 T1 的 pick 签名一致）
  });
  it("③ 上下键经视口渲染：窗口外条数提示行（… 第 X–Y 项，共 N 项）", async () => {
    const w: string[] = [];
    const items = Array.from({ length: 30 }, (_, i) => `s${i}`);
    await pick(items, { ...fakeIo(["\x1b[6~", "\r"], w), height: 10 });
    const out = w.join("");
    expect(out).toContain("…（第 1–10 项，共 30 项）"); // 首帧窗口
    expect(out).toContain("…（第 2–11 项，共 30 项）"); // PageDown 后选中项 10 → 窗口 {1,11}
    expect(out).toContain("\x1b[7ms10\x1b[27m"); // 选中项反色随窗口滚动
  });
});
