import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInput, readInputs } from "./inputs.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("T13 m5-resume-perf: 输入历史 sidecar inputs.jsonl（召回与大会话转录解耦）", () => {
  it("a. append 后 readInputs 尾部序正确（时间序最新在末）、100 条帽、空串不记；best-effort 不炸", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-in-"));
    for (let i = 1; i <= 105; i++) appendInput(dir, "s_a", `输入 ${i}`);
    appendInput(dir, "s_a", ""); // 空不记
    const texts = readInputs(dir, "s_a");
    expect(texts).toHaveLength(100); // 帽 100
    expect(texts[0]).toBe("输入 6"); // 尾部 100 条（1..105 的 6..105）
    expect(texts[99]).toBe("输入 105"); // 时间序：最新在末（inputHistoryTexts 同序）
    expect(readInputs(dir, "s_a", 3)).toEqual(["输入 103", "输入 104", "输入 105"]); // limit 参数
    // 不存在/坏路径 → 空数组不炸；append 到非法 sid → no-op 不炸（防御面）
    expect(readInputs(dir, "s_nope")).toEqual([]);
    appendInput(dir, "../escape", "x");
    expect(readInputs(dir, "../escape")).toEqual([]);
    // append IO 失败吞：只读目录不炸（Windows 目录权限语义不稳——用不存在父目录的非法路径形态验证）
    appendInput(join(dir, "missing", "deep"), "s_x", "y"); // mkdir 不在 appendInput 职责内——吞错即可
  });

  it("b. 撕裂尾/坏行容错：末行半截 JSON 跳过不炸、好行照常召回", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-in2-"));
    const agents = join(dir, "s_b", "agents");
    mkdirSync(agents, { recursive: true });
    const file = join(agents, "inputs.jsonl");
    writeFileSync(file, [
      JSON.stringify({ ts: "t", text: "第一条" }),
      JSON.stringify({ ts: "t", text: "第二条" }),
      '{"ts":"t","text":"半截', // 撕裂尾
    ].join("\n") + "\n");
    expect(readInputs(dir, "s_b")).toEqual(["第一条", "第二条"]);
  });

  it("c. 超帽文件只读尾段（512KB 防御帽——首行斩断丢弃）", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-in3-"));
    const agents = join(dir, "s_c", "agents");
    mkdirSync(agents, { recursive: true });
    const file = join(agents, "inputs.jsonl");
    // 造 >512KB：一批长文本行
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(JSON.stringify({ ts: "t", text: `行 ${i} ${"长".repeat(500)}` })); // ≈1500B/行 × 200 ≈ 300KB…加大
    for (let i = 200; i < 500; i++) lines.push(JSON.stringify({ ts: "t", text: `行 ${i} ${"长".repeat(2000)}` })); // ≈6KB/行 × 300 ≈ 1.8MB
    writeFileSync(file, lines.join("\n") + "\n");
    const texts = readInputs(dir, "s_c", 50);
    expect(texts).toHaveLength(50);
    expect(texts[49]).toContain("行 499"); // 最新在末
    expect(texts[0]).toContain(`行 ${500 - 50}`); // 尾部 50 条
  });
});
