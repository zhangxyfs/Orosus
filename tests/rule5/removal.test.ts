import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore, type Harness } from "@orosus/core";
import toolFs from "@orosus/tool-fs";
import toolShell from "@orosus/tool-shell";
import providerCustom from "@orosus/provider-custom";
import type { ModuleDefinition } from "@orosus/contracts/module";

let dir: string;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 夹具模块池（2026-09-23 provider 路线归一：品牌 ×5 退役，provider 位换 provider-custom——
 *  无配置 section 时 custom 空表也 active〔区内厂商校验〕，故不再覆盖「provider 缺 key 降级」支，
 *  该形态已随品牌 provider 消失）。 */
const BUILTINS: Record<string, ModuleDefinition> = {
  "tool-fs": toolFs,
  "tool-shell": toolShell,
  "provider-custom": providerCustom,
};

describe("规则 5 验收：核心不依赖任何模块（运行期半；编译期半由 pnpm check:boundaries 覆盖）", () => {
  it("逐个拿掉 / 全部拿掉内置模块，createHarness 均正常启动", async () => {
    const subsets: string[][] = [
      ["tool-shell", "provider-custom"],   // 拿掉 tool-fs
      ["tool-fs", "provider-custom"],      // 拿掉 tool-shell（连带失去 fs 消费方，tool-shell 本就不在）
      ["tool-fs", "tool-shell"],           // 拿掉 provider
      [],                                  // 全拿掉——裸核心也必须能起
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
      const expected = keep.filter((k) => k !== "tool-shell" || keep.includes("tool-fs"));
      expect(active.sort()).toEqual(expected.sort());
      await h.close();
      h = undefined;
    }
  });
});
