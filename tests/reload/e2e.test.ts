import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeModule, fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const script: Chunk[][] = [[{ type: "text/delta", text: "x" }, { type: "finish", kind: "stop" }]];

describe("reload 端到端（T20）", () => {
  it("代际：reload 后 Unchanged generation 不变；模块级失败不废除 reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-e2e-")); dirs.push(dir);
    const good = fakeModule("good", { activate() {} });
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      modules: [fakeProviderModule("fake", script), good],
      config: { userFile: join(dir, "no.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    const r1 = await h.reload();
    expect(r1.failed).toEqual([]);
    expect(r1.unchanged).toContain("good");
    const rec = h.graph().records.find((x) => x.name === "good")!;
    expect(rec.generation).toBe(1); // Unchanged 代际不变（§5.5）
    await h.close();
  });

  it("quiesce：turn 边界后生效；会话日志连续（reload 不动会话，§5.5）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-e2e-")); dirs.push(dir);
    const store = new InMemorySessionStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hang = fakeModule("provider-h", {
      activate(ctx) {
        ctx.provide("provider:h", async function* () { await gate; yield { type: "finish", kind: "stop" } as const; });
      },
    });
    const h = await createHarness({
      store, diagDir: dir, spillDir: join(dir, "spill"),
      modules: [hang],
      config: { userFile: join(dir, "no.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "h/x" } },
    });
    const turnP = h.prompt("hi");
    const eventsBefore = (await store.all()).length;
    const rP = h.reload();
    release();
    await turnP;
    const report = await rP;
    expect(report.unchanged).toContain("provider-h");
    const all = await store.all();
    expect(all.length).toBeGreaterThan(eventsBefore); // 会话日志连续追加，reload 不清不动
    await h.close();
  });
});
