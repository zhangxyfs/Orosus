import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore, type Harness } from "@orosus/core";
import toolFs from "@orosus/tool-fs";
import toolShell from "@orosus/tool-shell";
import anthropic from "@orosus/provider-anthropic";
import type { ModuleDefinition } from "@orosus/contracts/module";

let dir: string;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

const BUILTINS: Record<string, ModuleDefinition> = {
  "tool-fs": toolFs,
  "tool-shell": toolShell,
  "provider-anthropic": anthropic,
};

describe("规则 5 验收：核心不依赖任何模块（运行期半；编译期半由 pnpm check:boundaries 覆盖）", () => {
  it("逐个拿掉 / 全部拿掉内置模块，createHarness 均正常启动", async () => {
    const subsets: string[][] = [
      ["tool-shell", "provider-anthropic"],   // 拿掉 tool-fs
      ["tool-fs", "provider-anthropic"],      // 拿掉 tool-shell（连带失去 fs 消费方，tool-shell 本就不在）
      ["tool-fs", "tool-shell"],              // 拿掉 provider
      [],                                     // 全拿掉——裸核心也必须能起
    ];
    for (const keep of subsets) {
      dir = mkdtempSync(join(tmpdir(), "orosus-rule5-"));
      h = await createHarness({
        store: new InMemorySessionStore(),
        diagDir: dir,
        spillDir: join(dir, "spill"),
        config: { userFile: join(dir, "no-user.toml"), projectFile: join(dir, "no-proj.toml"), env: {} },
        builtinModules: keep.map((k) => BUILTINS[k]!),
      });
      const active = h.graph().records.filter((r) => r.state === "active").map((r) => r.name);
      // tool-shell 依赖 fs 能力：tool-fs 缺席时它级联 failed，这是设计行为而非规则 5 违例
      const expected = keep.filter((k) => k !== "provider-anthropic" && (k !== "tool-shell" || keep.includes("tool-fs")));
      expect(active.sort()).toEqual(expected.sort());
      // provider-anthropic 无配置 section → config 校验失败降级（不阻断启动，§10）
      if (keep.includes("provider-anthropic")) {
        expect(h.graph().records.find((r) => r.name === "provider-anthropic")?.state).toBe("failed");
      }
      await h.close();
      h = undefined;
    }
  });
});
