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
