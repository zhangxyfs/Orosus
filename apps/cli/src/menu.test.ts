import { describe, it, expect } from "vitest";
import { createMaskingOutput, createReadlineUi } from "./menu.ts";

describe("readline 版 CommandUi（menu 组件，D35/D38 语言约定注记）", () => {
  it("choose：编号选择，无效序号重问后命中", async () => {
    const answers = ["99", "2"];
    const ui = createReadlineUi({ question: async () => answers.shift() ?? "", secretQuestion: async () => "" });
    const picked = await ui.choose("选择平台", ["甲", "乙", "丙"]);
    expect(picked).toBe("乙");
  });
  it("confirm：y/Y 为真，其余为假；ask 原样返回 trim 后输入；askSecret 走掩码询问口", async () => {
    const answers = ["y", "n", "  hello  "];
    const secrets: string[] = [];
    const ui = createReadlineUi({ question: async () => answers.shift() ?? "", secretQuestion: async (q) => { secrets.push(q); return "  sk-x  "; } });
    expect(await ui.confirm("继续？")).toBe(true);
    expect(await ui.confirm("继续？")).toBe(false);
    expect(await ui.ask("名字")).toBe("hello");
    expect(await ui.askSecret("粘贴 KEY")).toBe("sk-x");
    expect(secrets).toEqual(["粘贴 KEY"]);
  });
});

describe("掩码输出代理（密钥回显 *，用户走查：明文上屏并进终端滚动历史）", () => {
  it("mask on：可打印字符逐个替换为 *；控制序列（退屏 \\b \\b、换行）透传", async () => {
    const out: string[] = [];
    const w = createMaskingOutput({ write: (s) => void out.push(s) });
    const push = (s: string): Promise<void> => new Promise((r) => w.write(s, () => r()));
    await push("abc"); // mask off → 原样
    expect(out.at(-1)).toBe("abc");
    w.setMask(true);
    await push("sk-secret");
    expect(out.at(-1)).toBe("*********");
    await push("\b \b");
    expect(out.at(-1)).toBe("\b \b");
    await push("a\nb");
    expect(out.at(-1)).toBe("*\n*");
    w.setMask(false);
    await push("正常");
    expect(out.at(-1)).toBe("正常");
  });
});
