import { describe, it, expect } from "vitest";
import { createReadlineUi, createSilenceableOutput } from "./menu.ts";

describe("readline 版 CommandUi（menu 组件，D35/D38 语言约定注记）", () => {
  it("choose：编号选择，无效序号重问后命中", async () => {
    const answers = ["99", "2"];
    const ui = createReadlineUi({ question: async () => answers.shift() ?? "", secretQuestion: async () => "" });
    const picked = await ui.choose("选择平台", ["甲", "乙", "丙"]);
    expect(picked).toBe("乙");
  });
  it("choose：TTY 引擎注入面——pick 面 reject 统一映射「已取消（Esc）」（机制③统一文案的装配层钉，硬约束 1）", async () => {
    const ui = createReadlineUi({
      // question 恒给合法序号：未接 pick 面的旧实现会正常返回（断言随之失败）而非死循环重问
      question: async () => "1",
      secretQuestion: async () => "",
      pick: async () => {
        throw new Error("注入的取消");
      },
    });
    await expect(ui.choose("选择平台", ["甲"])).rejects.toThrow("已取消（Esc）");
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

describe("可静默输出代理（密钥输入无回显——逐键 * 在真实 Windows 终端层碎成孤星，走查改盲输）", () => {
  it("silence on：一切回显（含 ANSI 刷新/控制序列/换行）全吞；off 恢复透传", async () => {
    const out: string[] = [];
    const w = createSilenceableOutput({ write: (s) => void out.push(s) });
    const push = (s: string): Promise<void> => new Promise((r) => w.write(s, () => r()));
    await push("正常");
    expect(out).toEqual(["正常"]);
    w.silence(true);
    await push("sk-secret");
    await push("\x1b[1G\x1b[0J");
    await push("a\nb");
    expect(out).toEqual(["正常"]); // 静默期零输出
    w.silence(false);
    await push("恢复");
    expect(out).toEqual(["正常", "恢复"]);
  });
});
