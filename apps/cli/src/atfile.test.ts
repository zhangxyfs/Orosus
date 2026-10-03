import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAtRefs } from "./atfile.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orosus-atfile-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("@文件引用（M4-2 T18/B18——限 5 个/单文件 50KB）", () => {
  it("① @package.json 存在且小 → attachments 含文件内容、引用从原文本移除", () => {
    writeFileSync(join(dir, "package.json"), '{"name":"x"}', "utf8");
    const r = resolveAtRefs("看看 @package.json 这是什么", dir);
    expect(r.attachments.join("\n")).toContain('"name":"x"');
    expect(r.text).not.toContain("@package.json");
    expect(r.text).toContain("看看");
    expect(r.text).toContain("这是什么");
  });

  it("② @nonexistent → 跳过提示；>50KB 文件 → 文件过大跳过；普通文本零改动", () => {
    const r1 = resolveAtRefs("看 @nonexistent 文件", dir);
    expect(r1.attachments.some((a) => a.includes("文件不存在") && a.includes("已跳过"))).toBe(true);
    writeFileSync(join(dir, "big.txt"), "x".repeat(51 * 1024), "utf8");
    const r2 = resolveAtRefs("看 @big.txt", dir);
    expect(r2.attachments.some((a) => a.includes("文件过大") && a.includes("已跳过"))).toBe(true);
    const r3 = resolveAtRefs("没有引用的普通消息", dir);
    expect(r3).toEqual({ text: "没有引用的普通消息", attachments: [] });
  });
});

describe("@ 行范围引用（TUI 批 T6——B18 半项）", () => {
  it("① @p#L10-L20 → 只附着第 10–20 行，标注含 #L10-L20；原文本引用整匹配移除（#L 尾巴不残留）", () => {
    writeFileSync(join(dir, "rows.txt"), Array.from({ length: 30 }, (_, i) => `row${i + 1}`).join("\n"), "utf8");
    const r = resolveAtRefs("看 @rows.txt#L10-L20 这段", dir);
    const att = r.attachments.join("\n");
    expect(att).toContain("[@rows.txt#L10-L20]"); // 标注含行范围
    expect(att).toContain("row10");
    expect(att).toContain("row20");
    expect(att).not.toContain("row9");
    expect(att).not.toContain("row21");
    expect(r.text).not.toContain("@rows.txt");
    expect(r.text).not.toContain("#L10-L20"); // 整匹配删除——无 #L 残留
    expect(r.text).toContain("这段");
  });
  it("② #L10 与 #L10-20 等价形态；越界钳制（#L999 → 至文件尾）", () => {
    writeFileSync(join(dir, "rows.txt"), Array.from({ length: 30 }, (_, i) => `row${i + 1}`).join("\n"), "utf8");
    const single = resolveAtRefs("@rows.txt#L10", dir).attachments.join("\n");
    expect(single).toContain("row10");
    expect(single).not.toContain("row11");
    const shortForm = resolveAtRefs("@rows.txt#L10-20", dir).attachments.join("\n");
    expect(shortForm).toContain("row10");
    expect(shortForm).toContain("row20"); // #L10-20 与 #L10-L20 等价
    const clamped = resolveAtRefs("@rows.txt#L999", dir).attachments.join("\n");
    expect(clamped).toContain("row30"); // 越界钳制至文件尾
    expect(clamped).not.toContain("row29");
  });
  it("③ 空区间（#L20-L10）→ 带内提示跳过；@路径#非L后缀 整体不匹配原文透传（v1.6 行为变化注记）；无范围形态回归不变", () => {
    writeFileSync(join(dir, "rows.txt"), Array.from({ length: 30 }, (_, i) => `row${i + 1}`).join("\n"), "utf8");
    const empty = resolveAtRefs("@rows.txt#L20-L10", dir);
    expect(empty.attachments.some((a) => a.includes("行范围为空") && a.includes("已跳过"))).toBe(true);
    expect(empty.text).toContain("@rows.txt#L20-L10"); // 跳过路径不移除原文（与文件不存在同宗）
    const nonL = resolveAtRefs("看 @rows.txt#x 这个", dir);
    expect(nonL.attachments).toEqual([]); // #非L 后缀 → 不是引用、按普通文本透传
    expect(nonL.text).toBe("看 @rows.txt#x 这个");
    const whole = resolveAtRefs("@rows.txt", dir).attachments.join("\n");
    expect(whole).toContain("row1");
    expect(whole).toContain("row30"); // 无范围形态回归：整文件
  });
});

describe("引用移除按匹配位置（CR-03——text.replace 删首个出现会误啃非引用文本）", () => {
  it("① 非引用同名文本先于真引用出现：「看 x@rows.txt 和 @rows.txt」只删真引用——x@ 片段原样、真引用不残留正文", () => {
    writeFileSync(join(dir, "rows.txt"), Array.from({ length: 30 }, (_, i) => `row${i + 1}`).join("\n"), "utf8");
    const r = resolveAtRefs("看 x@rows.txt 和 @rows.txt", dir);
    expect(r.attachments).toHaveLength(1); // 真引用只附着一次（x@ 片段不是引用——无边界不匹配）
    expect(r.attachments[0]).toContain("row1"); // 附着的是真文件内容
    // 旧实现产出「看 x 和 @rows.txt」：非引用被啃成 x、真引用残留（附件+正文语义重复）
    expect(r.text).toBe("看 x@rows.txt 和 ");
  });
  it("② 多处真引用按各自匹配位置整删（从后往前套删——索引不漂移）、附着保持原文顺序", () => {
    writeFileSync(join(dir, "a.txt"), "AAA", "utf8");
    writeFileSync(join(dir, "b.txt"), "BBB", "utf8");
    const r = resolveAtRefs("@a.txt 中 @b.txt 尾", dir);
    expect(r.attachments[0]).toContain("AAA"); // 附着顺序随原文出现序
    expect(r.attachments[1]).toContain("BBB");
    expect(r.text).toBe(" 中  尾"); // 两处整删（各含边界空格归属正确，无互相误伤）
  });
});

describe("中文紧贴边界放宽（m5-at-menu T4/D14——@ 前一字符不是路径合法字符即算引用起点）", () => {
  it("① 「看下@src/a.ts」解析成附件且正文只删引用段——「下」字完好（今天静默失效的第三形态）", () => {
    writeFileSync(join(dir, "a.ts"), "CONTENT", "utf8");
    const r = resolveAtRefs("看下@a.ts 结束", dir);
    expect(r.attachments.join("\n")).toContain("CONTENT");
    expect(r.text).toBe("看下 结束"); // 引用段整删、「看下」完好
  });
  it("② 中文标点后紧贴「，@a.txt」也成引用（标点不属于路径合法字符；词尾串尾 $ 终止）", () => {
    writeFileSync(join(dir, "a.txt"), "MARKED", "utf8");
    const r = resolveAtRefs("注意，@a.txt", dir);
    expect(r.attachments.join("\n")).toContain("MARKED");
    expect(r.text).toBe("注意，");
    // 词尾紧跟中文句号会连带吃进路径（词 = 非空白非 # 最大段——v1 接受，带内跳过提示可见）
    const glued = resolveAtRefs("注意，@a.txt。", dir);
    expect(glued.attachments.some((a) => a.includes("文件不存在") && a.includes("已跳过"))).toBe(true);
    expect(glued.text).toBe("注意，@a.txt。");
  });
  it("③ 邮箱 foo@bar.com 不误吃（@ 前是 o 路径合法字符——新旧规则都不算引用）", () => {
    const r = resolveAtRefs("联系 foo@bar.com 谈", dir);
    expect(r.attachments).toEqual([]);
    expect(r.text).toBe("联系 foo@bar.com 谈");
  });
  it("④ 行首与空白前的旧行为逐字节不变（纯放宽、零翻案）", () => {
    writeFileSync(join(dir, "a.txt"), "AAA", "utf8");
    const head = resolveAtRefs("@a.txt 开头", dir); // 行首
    expect(head.text).toBe(" 开头");
    const spaced = resolveAtRefs("正文 @a.txt 正文", dir); // 空白前
    expect(spaced.text).toBe("正文  正文");
    expect(spaced.attachments[0]).toContain("AAA");
  });
  it("⑤ CR-03 双引用旧形态原样绿：「看 x@rows.txt 和 @rows.txt」x@ 片段仍不是引用", () => {
    writeFileSync(join(dir, "rows.txt"), "row1", "utf8");
    const r = resolveAtRefs("看 x@rows.txt 和 @rows.txt", dir);
    expect(r.attachments).toHaveLength(1);
    expect(r.text).toBe("看 x@rows.txt 和 ");
  });
  it("⑥ #L 行范围与 50KB 上限在 glued 形态下照常工作", () => {
    writeFileSync(join(dir, "rows.txt"), Array.from({ length: 30 }, (_, i) => `row${i + 1}`).join("\n"), "utf8");
    const ranged = resolveAtRefs("看下@rows.txt#L2-L3 部分", dir);
    const att = ranged.attachments.join("\n");
    expect(att).toContain("[@rows.txt#L2-L3]");
    expect(att).toContain("row2");
    expect(att).not.toContain("row4");
    expect(ranged.text).toBe("看下 部分");
    writeFileSync(join(dir, "big.txt"), "x".repeat(51 * 1024), "utf8");
    const big = resolveAtRefs("看下@big.txt", dir);
    expect(big.attachments.some((a) => a.includes("文件过大"))).toBe(true);
    expect(big.text).toBe("看下@big.txt"); // 跳过路径不移除原文（与文件不存在同宗——引用保留）
  });
});
