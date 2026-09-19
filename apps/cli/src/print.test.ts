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

const mkH = async () => {
  dir = mkdtempSync(join(tmpdir(), "orosus-print-"));
  const script: Chunk[][] = [[{ type: "text/delta", text: "你好，世界" }, { type: "usage", input: 10, output: 2 }, { type: "finish", kind: "stop" }]];
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
});
