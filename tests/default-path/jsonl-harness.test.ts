import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, JsonlSessionStore, type Harness } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";

let dir: string;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("默认路径：JsonlSessionStore × createHarness（真实 CLI 同款组合）", () => {
  it("一轮 prompt 落盘 JSONL 且 seq 单调连续（loop 投影走默认 store 的 all()）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-default-"));
    const script: Chunk[][] = [[{ type: "text/delta", text: "好" }, { type: "finish", kind: "stop" }]];
    const store = new JsonlSessionStore({ dir: join(dir, "sessions") });
    h = await createHarness({
      store,
      diagDir: dir,
      spillDir: join(dir, "spill"),
      modules: [fakeProviderModule("fake", script)],
      config: {
        userFile: join(dir, "no-user.toml"), projectFile: join(dir, "no-proj.toml"), env: {},
        cliOverrides: { model: "fake/m" },
      },
    });
    await h.prompt("hi");
    await h.close();
    h = undefined;
    const file = join(dir, "sessions", `${store.sessionId}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const recs = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; seq: number });
    const types = recs.map((r) => r.type);
    expect(types[0]).toBe("session/header");
    expect(types).toContain("user/message");
    expect(types).toContain("assistant/message");
    expect(types[types.length - 1]).toBe("turn/end");
    expect(recs.map((r) => r.seq)).toEqual(recs.map((_, i) => i + 1)); // seq 单调连续无空洞
  });
});
