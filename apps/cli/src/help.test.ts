import { describe, it, expect } from "vitest";
import { commandCompleter, HELP_TEXT } from "./help.ts";

describe("completer + /help（M4-2 T21/B5）", () => {
  it("① commandCompleter：/re → 含 /resume+/reload；唯一命中单元素；非命令行零补全", () => {
    const [hits1, line1] = commandCompleter("/re");
    expect(hits1).toContain("/resume");
    expect(hits1).toContain("/reload");
    expect(line1).toBe("/re"); // readline/promises CompleterResult 第二位回传原行
    const [hits2] = commandCompleter("/con");
    expect(hits2).toEqual(["/context"]); // 唯一命中——readline 自行补全
    expect(commandCompleter("普通文本")[0]).toEqual([]);
    expect(commandCompleter("")[0]).toEqual([]);
  });

  it("② HELP_TEXT：三组命令名 + 每条中文说明（如 /new 开始新会话）", () => {
    expect(HELP_TEXT).toContain("CLI 命令（会话生命周期）");
    expect(HELP_TEXT).toContain("内建命令（模型与状态）");
    expect(HELP_TEXT).toContain("模块命令");
    expect(HELP_TEXT).toContain("/new        开始新会话");
    expect(HELP_TEXT).toContain("/paste      粘贴剪贴板图片（或 Alt+V 按键）"); // T5 可发现性：新键位入帮助
    expect(HELP_TEXT).toContain("/permission 查看或切换审批模式");
    expect(HELP_TEXT).toContain("Tab 补全");
  });
});
