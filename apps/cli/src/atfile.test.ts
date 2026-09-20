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
