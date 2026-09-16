import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeModule } from "@orosus/testing";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("golden log：启动诊断 code 与字段 schema 稳定（§11.9）", () => {
  it("成功 + 降级混合启动 → kernel.module.active / kernel.module.failed 落条，字段齐全", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-golden-"));
    const h = await createHarness({
      store: new InMemorySessionStore(),
      diagDir: dir,
      spillDir: join(dir, "spill"),
      config: { userFile: join(dir, "no-user.toml"), projectFile: join(dir, "no-proj.toml"), env: {} },
      modules: [
        fakeModule("ok-mod"),
        fakeModule("bad-mod", { activate() { throw new Error("boom"); } }),
      ],
    });
    await h.close();
    // 按发现而非推算取文件：sink 按写入当日滚动，写读之间跨午夜时按读取时刻推算会失配
    const files = readdirSync(dir).filter((f) => f.startsWith("diagnostic-"));
    expect(files).toHaveLength(1);
    const recs = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const codes = recs.map((r) => r.code);
    expect(codes).toContain("kernel.module.active");
    expect(codes).toContain("kernel.module.failed");
    const active = recs.find((r) => r.code === "kernel.module.active")!;
    const failed = recs.find((r) => r.code === "kernel.module.failed")!;
    expect(active.lvl).toBe("info");
    expect(failed.lvl).toBe("warn");
    // golden schema：每条记录必备字段（诊断 schema 变更 = 破坏性变更，此测试强制走变更评审）
    for (const r of recs) {
      expect(r).toMatchObject({ v: 1, module: expect.any(String), code: expect.any(String), msg: expect.any(String) });
      expect(typeof r.ts).toBe("string");
      expect(["trace", "debug", "info", "warn", "error"]).toContain(r.lvl);
    }
  });
});
