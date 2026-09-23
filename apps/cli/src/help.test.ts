import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandCompleter, HELP_TEXT } from "./help.ts";

describe("completer + /help（M4-2 T21/B5）", () => {
  it("① commandCompleter：/re → 含 /resume+/reload；唯一命中单元素；非命令行零补全", () => {
    const [hits1, line1] = commandCompleter("/re");
    expect(hits1).toContain("/resume");
    expect(hits1).toContain("/reload");
    expect(line1).toBe("/re"); // readline/promises CompleterResult 第二位回传原行
    const [hits2] = commandCompleter("/ren");
    expect(hits2).toEqual(["/rename"]); // 唯一命中——readline 自行补全（批⑤⑥：/context 退役后原 /con 唯一命中钉换成 /ren）
    expect(commandCompleter("普通文本")[0]).toEqual([]);
    expect(commandCompleter("")[0]).toEqual([]);
  });

  it("② HELP_TEXT：三组命令名 + 每条中文说明（如 /new 开始新会话）；退役命令（/usage /status /context /paste）不再列", () => {
    expect(HELP_TEXT).toContain("CLI 命令（会话生命周期）");
    expect(HELP_TEXT).toContain("内建命令（模型与状态）");
    expect(HELP_TEXT).toContain("模块命令");
    expect(HELP_TEXT).toContain("/new        开始新会话");
    expect(HELP_TEXT).not.toContain("\n  /usage"); // 行首命令位不再列（/other 行内的「/usage /status 已并入」指路属有意保留）
    expect(HELP_TEXT).not.toContain("\n  /status");
    expect(HELP_TEXT).not.toContain("/paste "); // 批⑤⑥退役清理（Alt+V 提示并入尾部提示行）
    expect(HELP_TEXT).toContain("Alt+V"); // T5 可发现性：图片键位仍在帮助
    expect(HELP_TEXT).toContain("Ctrl+U"); // 队列批可发现性：steer 键位入帮助（2026-09-23）
    expect(HELP_TEXT).toContain("/permission 查看或切换审批模式");
    expect(HELP_TEXT).toContain("Tab 补全");
    expect(HELP_TEXT).toContain("@ 后 Tab 补全文件"); // T6 可发现性：@ 补全与 #L 语法入提示行
    expect(HELP_TEXT).toContain("@path#L10-L20 引用行范围");
  });
});

describe("@ 文件补全（TUI 批 T6——B18 半项）", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orosus-atcomp-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("④ 行尾 @src/ → 候选 = src 下前缀匹配项（目录以 / 结尾）；唯一命中补入行内（匹配段 = @前缀）", () => {
    mkdirSync(join(dir, "sub", "inner"), { recursive: true });
    writeFileSync(join(dir, "sub", "a.ts"), "a", "utf8");
    writeFileSync(join(dir, "sub", "b.ts"), "b", "utf8");
    const [hits, matched] = commandCompleter("看看 @sub/", dir);
    expect(hits).toContain("@sub/a.ts");
    expect(hits).toContain("@sub/b.ts");
    expect(hits).toContain("@sub/inner/"); // 目录以 / 结尾——补入后可继续 Tab
    expect(matched).toBe("@sub/"); // 第二参 = @ 匹配段（不含行首文本——readline 只替换这段）
    const [one] = commandCompleter("看看 @sub/a", dir);
    expect(one).toEqual(["@sub/a.ts"]); // 唯一命中——readline 自行补入
  });
  it("⑤ 候选超 20 截断（设计空白）；命令补全回归（/ 开头行为不变——既有用例为钉）", () => {
    mkdirSync(join(dir, "big"), { recursive: true });
    for (let i = 1; i <= 25; i++) writeFileSync(join(dir, "big", `f${String(i).padStart(2, "0")}.txt`), "x", "utf8");
    const [hits] = commandCompleter("@big/f", dir);
    expect(hits.length).toBe(20);
    expect(hits.every((h) => h.startsWith("@big/f"))).toBe(true);
    expect(commandCompleter("/re")[0]).toContain("/resume"); // / 开头回归
  });
  it("⑥ 非 @ 非 / 行 → 空候选（现状回归）；目录不存在静默空候选", () => {
    expect(commandCompleter("hello", dir)).toEqual([[], "hello"]);
    expect(commandCompleter("看看 @nodir/x", dir)[0]).toEqual([]);
  });
});
