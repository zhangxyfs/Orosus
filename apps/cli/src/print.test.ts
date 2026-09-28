import { describe, it, expect, afterEach } from "vitest";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrint } from "./print.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const mkH = async (script: Chunk[][] = [[{ type: "text/delta", text: "你好，世界" }, { type: "usage", input: 10, output: 2 }, { type: "finish", kind: "stop" }]]) => {
  dir = mkdtempSync(join(tmpdir(), "orosus-print-"));
  return createHarness({
    store: new InMemorySessionStore(),
    diagDir: dir, spillDir: join(dir, "spill"),
    modules: [fakeProviderModule("fake", script)],
    config: { userFile: join(dir, "n.toml"), projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
  });
};

describe("--print 三格式（M4-2 T17/B17）", () => {
  it("① text 格式 → write 收到最后一条 assistant 正文", async () => {
    const h = await mkH();
    const out: string[] = [];
    await runPrint(h, "打个招呼", {}, (s) => out.push(s));
    expect(out.join("")).toContain("你好，世界");
  });

  it("② json 格式 → 输出可 JSON.parse 且含 usage/content/sessionId", async () => {
    const h = await mkH();
    const out: string[] = [];
    await runPrint(h, "打个招呼", { outputFormat: "json" }, (s) => out.push(s));
    const parsed = JSON.parse(out.join("")) as { sessionId?: string; usage?: unknown; content?: string };
    expect(parsed.sessionId).toEqual(h.sessionId);
    expect(parsed.content).toContain("你好，世界");
    expect(parsed.usage).toBeDefined();
  });

  it("③ stream-json 格式 → 逐行 JSON.parse 且含 turn/end", async () => {
    const h = await mkH();
    const out: string[] = [];
    await runPrint(h, "打个招呼", { outputFormat: "stream-json" }, (s) => out.push(s));
    expect(out.length).toBeGreaterThan(1);
    const events = out.map((l) => JSON.parse(l) as { type?: string });
    expect(events.some((e) => e.type === "turn/end")).toBe(true);
    expect(events.every((e) => typeof e.type === "string")).toBe(true);
  });

  it("④ CM-04：turn 终态可见——正常完成 = completed；provider 错误（finish kind error）= error——main 按此置退出码（脚本可分辨失败，空正文不再静默 exit 0）", async () => {
    const ok = await mkH();
    const okOut: string[] = [];
    const okOutcome = await runPrint(ok, "打个招呼", {}, (s) => okOut.push(s));
    expect(okOutcome.turnEndKind).toBe("completed");
    await ok.close(); // runPrint 已关（事件收集收口件）——此处幂等，与 main 的 finally 兜底同契约
    rmSync(dir!, { recursive: true, force: true }); // mkH 复用模块级 dir——腾位给第二台 harness 的 afterEach 清理
    const bad = await mkH([[{ type: "finish", kind: "error", errorMessage: "HTTP 401（测试注入）" }]]);
    const badOut: string[] = [];
    const badOutcome = await runPrint(bad, "打个招呼", {}, (s) => badOut.push(s));
    expect(badOutcome.turnEndKind).toBe("error"); // 非 completed → main 置退出码 1（CM-04③ 的判定输入）
    expect(badOut.join("")).not.toContain("你好，世界"); // 空正文——退出码是唯一失败信号
  });

  it("⑤ CM-20：json 的 model 读 harness 读口——未传 --model 键不再消失（取实际生效模型，含 override 语义）", async () => {
    const h = await mkH(); // 夹具 cliOverrides.model = "fake/m"（等价 config 生效模型——无 --model 场景）
    const out: string[] = [];
    await runPrint(h, "打个招呼", { outputFormat: "json" }, (s) => out.push(s)); // args.model 缺席
    const parsed = JSON.parse(out.join("")) as { model?: string };
    expect(parsed.model).toBe("fake/m"); // 旧：取 args.model=undefined → JSON.stringify 整键消失
  });
});
