import { describe, it, expect } from "vitest";
import { formatStartupError } from "./startup-error.ts";

describe("formatStartupError（T6/S7：启动失败友好错误面）", () => {
  it("Error 输入 → 首行原因 + 日志路径行（UTC 日期与 logger 同式）", () => {
    const out = formatStartupError(new Error("TOML 解析失败：expected '=' at line 3\n    at parse (smol-toml)"), "/tmp/orosus-home", new Date("2026-09-25T23:30:00.000Z"));
    expect(out.split("\n")).toEqual([
      "启动失败：TOML 解析失败：expected '=' at line 3",
      "诊断日志：/tmp/orosus-home/logs/diagnostic-2026-09-25.jsonl",
    ]);
  });

  it("非 Error 输入 → String 化兜底不炸", () => {
    const out = formatStartupError("boom", "/h", new Date("2026-01-02T00:00:00.000Z"));
    expect(out).toContain("启动失败：boom");
    expect(out).toContain("/h/logs/diagnostic-2026-01-02.jsonl");
  });
});
