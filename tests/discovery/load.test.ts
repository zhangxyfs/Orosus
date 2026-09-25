import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const md = (p: string) => mkdirSync(p, { recursive: true });

const ECHO_MODULE = [
  'import { defineModule } from "@orosus/contracts/module";',
  'import { defineTool } from "@orosus/contracts/tool";',
  'import { z } from "zod";',
  "export default defineModule({",
  '  name: "echo-mod",',
  '  version: "0.1.0",',
  '  description: "echo",',
  "  api: 1,",
  '  mounts: ["contribute:tool"],',
  "  uses: [],",
  "  activate(ctx) {",
  "    ctx.contribute.tool(defineTool({",
  '      name: "echo-mod__hi",',
  '      description: "hi",',
  "      parameters: z.object({}),",
  '      resolveExecution: async () => ({ execute: async () => ({ output: "from-external", isError: false }) }),',
  "    }));",
  "  },",
  "});",
].join("\n");

describe("目录发现端到端（T20）：jiti 加载真实 TS 模块 → 注册工具 → prompt 走通", () => {
  it("用户级模块经 jiti 加载、激活、贡献工具；prompt 全流程可用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-disc-")); dirs.push(dir);
    md(join(dir, "mods", "echo-mod"));
    writeFileSync(join(dir, "mods", "echo-mod", "index.ts"), ECHO_MODULE);
    const store = new InMemorySessionStore();
    const script: Chunk[][] = [[{ type: "text/delta", text: "x" }, { type: "finish", kind: "stop" }]];
        // m5 T17：用户级从「恒免」修订为「一次性确认」——先登记信任（模拟首挂确认后的 trust.json）
    {
      const { createHash } = await import("node:crypto");
      const { trustModule } = await import("@orosus/core");
      trustModule(join(dir, "trust.json"), join(dir, "mods", "echo-mod"), createHash("sha256").update(readFileSync(join(dir, "mods", "echo-mod", "index.ts"), "utf8")).digest("hex"));
    }
const h = await createHarness({
      store, diagDir: dir, spillDir: join(dir, "spill"),
      modules: [fakeProviderModule("fake", script)],
      discovery: { userDir: join(dir, "mods"), projectDir: join(dir, "none"), trustFile: join(dir, "trust.json") },
      config: { userFile: join(dir, "no.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    expect(h.graph().records.find((r) => r.name === "echo-mod")?.state).toBe("active"); // 登记过即过（m5 T17：用户级一次性确认）
    expect(h.graph().tools.list().map((t) => t.name)).toContain("echo-mod__hi");
    const r = await h.graph().tools.run({ id: "c1", name: "echo-mod__hi", args: {} }, { signal: new AbortController().signal });
    expect(r.output).toBe("from-external");
    await h.prompt("hi"); // 全流程走通（fake provider）
    await h.close();
  });
});
