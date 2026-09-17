import { describe, it, expect } from "vitest";
import { createReadlineUi } from "./menu.ts";

describe("readline 版 CommandUi（menu 组件，D35/D38 语言约定注记）", () => {
  it("choose：编号选择，无效序号重问后命中", async () => {
    const answers = ["99", "2"];
    const ui = createReadlineUi({ question: async () => answers.shift() ?? "" });
    const picked = await ui.choose("选择平台", ["甲", "乙", "丙"]);
    expect(picked).toBe("乙");
  });
  it("confirm：y/Y 为真，其余为假；ask 原样返回 trim 后输入", async () => {
    const answers = ["y", "n", "  hello  "];
    const ui = createReadlineUi({ question: async () => answers.shift() ?? "" });
    expect(await ui.confirm("继续？")).toBe(true);
    expect(await ui.confirm("继续？")).toBe(false);
    expect(await ui.ask("名字")).toBe("hello");
  });
});
