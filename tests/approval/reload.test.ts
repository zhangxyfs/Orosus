import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "@orosus/core";
import type { ModuleDefinition } from "@orosus/contracts/module";
import approval from "@orosus/approval";

/** 审批 × reload（M3 T9，三轮护栏钉子）：改坏 approval 配置触发 activate 失败 → reload 图级失败、旧图继续运行
 *  ——§5.5 事务性 × §10 安全护栏（required = true）的交叉验证：审批绝不降级放行。 */
describe("审批 × reload（§5.5 × §10 安全护栏）", () => {
  it("approval 配置改坏 → reload 图级失败保留旧图（审批模块仍在线，工具照常被审批）", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-appr-reload-"));
    try {
      const userToml = join(d, "config.toml");
      writeFileSync(userToml, '[approval]\nmode = "ask-risky"\n', "utf8");
      const spyModule: ModuleDefinition = {
        name: "approval-spy", version: "0.1.0", description: "spies waterfall", api: 1,
        activate(ctx) {
          ctx.events.on("tool/pre-execute", () => undefined);
        },
      };
      const base = (tomlExists: boolean) => ({
        cwd: d,
        builtinModules: [approval],
        modules: [spyModule],
        secretsFile: join(d, "s.env"),
        diagDir: join(d, "logs"),
        spillDir: join(d, "spill"),
        discovery: { userDir: join(d, "m"), projectDir: join(d, "p"), trustFile: join(d, "t.json") },
        config: { userFile: tomlExists ? userToml : join(d, "none.toml"), projectFile: join(d, "n.toml"), env: {} },
      });
      const h = await createHarness(base(true));
      // 改坏配置：mode 非法值 → schema 拒绝 → approval（required=true）失败
      writeFileSync(userToml, '[approval]\nmode = "yolo-mode-typo"\n', "utf8");
      await expect(h.reload()).rejects.toThrow(/required|approval/);
      // 旧图继续运行：/help 仍可用，approval 模块仍 active
      const audit = h.graph().audit();
      expect(audit.find((a) => a.name === "approval")?.state).toBe("active");
      // 恢复配置后 reload 成功
      writeFileSync(userToml, '[approval]\nmode = "ask-risky"\n', "utf8");
      const report = await h.reload();
      expect(report.failed).toEqual([]);
      await h.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
