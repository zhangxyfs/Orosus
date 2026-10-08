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

// m5-ask-multi：pick(opts) 增强面——kimi 键路同款（空格/Enter 勾选、确定行提交、「其他」三态、
// 输入态自收、Esc 分层）；返回形状 { picked, custom } | undefined（D13 非 TTY 回落另测）
describe("pick 增强面 opts（m5-ask-multi——多选 + 自由输入）", () => {
  it("① 多选空格切换勾选、光标不动；确定行 Enter 提交勾选集（picked=原始下标集）", async () => {
    // ↓ 到乙、空格勾选（光标留乙）、↓↓↓ 到确定行（其他行占 items.length、确定行 +1）、Enter 提交
    const r = await pick(["甲", "乙", "丙"], fakeIo(["\x1b[B", " ", "\x1b[B", "\x1b[B", "\x1b[B", "\r"]), { multi: true });
    expect(r).toEqual({ picked: [1] });
  });
  it("② 多选普通项 Enter = 切换勾选（cc SelectMulti 同款——不是提交）；渲染含 ☐/■/✎/✓ 与 multi 脚注（走查修字形）", async () => {
    const w: string[] = [];
    const io = fakeIo(["\r", "\x1b[B", "\x1b[B", "\x1b[B", "\r"], w); // Enter 勾甲（非提交）→ ↓↓↓ 到确定行 → 提交
    const r = await pick(["甲", "乙"], io, { multi: true });
    expect(r).toEqual({ picked: [0] });
    const out = w.join("");
    expect(out).toContain("☐ 乙"); // 未勾项（空心方）
    expect(stripAnsi(out)).toContain("■ 甲"); // 勾选后——实心方（☑ 观感大一圈被走查否；accent 包裹断言走剥 ANSI）
    expect(out).not.toContain("☑"); // 旧字形退役
    expect(out).toContain("✎ 其他（自行输入）"); // 其他行（i18n zh-CN 测试环境）
    expect(out).toContain("✓ 确定"); // D16 提交口
    expect(out).toContain("空格/Enter 选定 · 确定行提交 · Esc 取消"); // pick.line.multiFoot（走查修中性措辞）
  });
  it("③ 零勾选在确定行 Enter = 提示不关窗（D5——行模式闪现提示行一拍），真提交照常", async () => {
    const w: string[] = [];
    const keys = [
      "\x1b[B", "\x1b[B", "\x1b[B", "\r", // ↓↓↓ 确定行 Enter（零勾）→ 提示不关窗
      "\x1b[A", "\x1b[A", " ", // ↑↑ 回乙、空格勾选
      "\x1b[B", "\x1b[B", "\r", // ↓↓ 确定行 Enter 提交
    ];
    const r = await pick(["甲", "乙"], fakeIo(keys, w), { multi: true });
    expect(w.join("")).toContain("未选择任何项");
    expect(r).toEqual({ picked: [1] });
  });
  it("④ 其他行三态：未勾 Enter 进输入、非空 Enter 单槽覆盖回列表（☑ ✎ 文本）、已勾 Enter 取消勾选；草稿续编", async () => {
    const w: string[] = [];
    const keys = [
      "\x1b[B", "\x1b[B", "\r", // ↓↓ 到其他行 Enter → 输入态
      "自", "定", "义", "\x7f", "义", "\r", // 输入「自定义」（含退格重输）
      "\r", // 其他行已勾 Enter → 取消勾选（kimi :301-307 对称撤销）
      "\r", // 再进输入态（草稿保留续编）
      "x", "\r", // 续编提交——单槽覆盖为「自定义x」
      "\x1b[B", "\r", // ↓ 确定行提交
    ];
    const r = await pick(["甲", "乙"], fakeIo(keys, w), { multi: true });
    const out = w.join("");
    expect(out).toContain("自行输入：自定"); // 输入行渲染（草稿直显）
    expect(stripAnsi(out)).toContain("■ ✎ 自定义"); // 提交态行显（走查修实心方字形——accent 包裹剥 ANSI 断言）
    expect(r).toEqual({ picked: [], custom: "自定义x" }); // 取消勾选清槽后再续编——最终单槽文本
  });
  it("⑤ 空输入 Enter 无效不动（kimi :344——不丢已输内容）、Esc 回列表草稿保留再进续编", async () => {
    const keys = [
      "\x1b[B", "\r", // ↓ 到其他行 Enter → 输入态
      "\r", // 空输入 Enter——无效不动
      "\x1b", // Esc 回列表（草稿保留）
      "\r", // 再进输入态（续编——customText 仍在）
      "！", "\r", // 续编 + 提交（多选回列表）
      "\x1b[B", "\r", // ↓ 确定行提交
    ];
    const r = await pick(["甲"], fakeIo(keys), { multi: true });
    expect(r).toEqual({ picked: [], custom: "！" }); // 空输入没丢草稿、Esc 后续编保留
  });
  it("⑥ Esc 分层：列表态 Esc = 取消整窗（「已取消（Esc）」）——MB-08 文案钉", async () => {
    await expect(pick(["甲"], fakeIo(["\x1b"]), { multi: true })).rejects.toThrow("已取消");
    await expect(pick(["甲"], fakeIo(["\x1b"]))).rejects.toThrow("已取消"); // 老面同款（既有钉复跑）
  });
  it("⑦ 单选确认流（走查修 2026-10-08——可撤回）：Enter/空格/数字=圆圈选定不即答、再按取消、他项移位、输入回列表、确定行提交", async () => {
    const w: string[] = [];
    // 空格选甲 → Enter 取消 → 数字 2 选乙（移位）→ ↓↓ 其他行输入「自由文本」（圆圈移到其他）→ ↓ 确定行提交
    const keys = [" ", "\r", "2", "\x1b[B", "\x1b[B", "\r", "自", "由", "文", "本", "\r", "\x1b[B", "\r"];
    const r = await pick(["甲", "乙"], fakeIo(keys, w), {});
    const out = w.join("");
    expect(stripAnsi(out)).toContain("● 甲"); // 圆圈选定行显（走查修：○/●——accent 包裹剥 ANSI 断言）
    expect(out).toContain("○ 乙"); // 未选空心圆（标记与文字均素色——裸串可断）
    expect(out).not.toContain("■"); // 方框字形不落单选面
    expect(stripAnsi(out)).toContain("● ✎ 自由文本"); // 输入提交后圆圈落到其他行
    expect(r).toEqual({ picked: [], custom: "自由文本" }); // 圆圈唯一——数字选的乙被自定义移出
    // 数字选定普通项 + 确定行提交（3 项单选：行域 5——数字 2 选乙后 ↓×4 到确定）
    expect(await pick(["甲", "乙", "丙"], fakeIo(["2", "\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "\r"]), {})).toEqual({ picked: [1] });
  });
  it("⑧ 多选数字直达让位（D7 防误触）：数字键被忽略、仍可导航提交", async () => {
    const r = await pick(["甲", "乙", "丙"], fakeIo(["1", "\x1b[B", "\r", "\x1b[B", "\x1b[B", "\x1b[B", "\r"]), { multi: true });
    // "1" 不直达（忽略）；↓乙 Enter 勾选；↓↓↓ 确定行（跳过其他行）Enter 提交
    expect(r).toEqual({ picked: [1] });
  });
  it("⑨ 非TTY 回落 D13：单选序号/自由文本；多选逗号分隔序号文本混排（中英逗号）；空重问", async () => {
    const seq = (answers: string[]) => { let i = 0; return { ...fakeIo([]), isTTY: false, numberQuestion: async () => answers[i++] ?? "" }; };
    expect(await pick(["a", "b", "c"], seq(["3"]), {})).toEqual({ picked: [2] });
    expect(await pick(["a", "b"], seq(["", "自定义答案"]), {})).toEqual({ picked: [], custom: "自定义答案" }); // 空先重问
    expect(await pick(["a", "b", "c"], seq(["1,3"]), { multi: true })).toEqual({ picked: [0, 2] });
    expect(await pick(["a", "b", "c"], seq(["2，自定义"]), { multi: true })).toEqual({ picked: [1], custom: "自定义" }); // 全角逗号 + 文本混排
    // 老面非TTY 原样（回归钉）：编号回落
    expect(await pick(["a", "b"], seq(["2"]))).toBe(1);
  });
});
