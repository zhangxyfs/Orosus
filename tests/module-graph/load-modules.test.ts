import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore, type Harness } from "@orosus/core";
import { fakeModule } from "@orosus/testing";
import type { ModuleDefinition } from "@orosus/contracts/module";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const boot = async (modules: ModuleDefinition[], config?: NonNullable<Parameters<typeof createHarness>[0]>["config"]) => {
  await h?.close(); // 重新 boot 前先收掉上一个（harness close 幂等，重复 close 无害）
  const dir = mkdtempSync(join(tmpdir(), "orosus-graph-"));
  dirs.push(dir); // 多次 boot 的 tmpdir 全部登记，afterEach 统一清理
  // 密封性：隔离配置文件 + spillDir，阻断真实 ~/.orosus 与 cwd 配置泄漏（见 Task 17 同款）
  h = await createHarness({
    store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"), modules,
    config: { userFile: join(dir, "no-user.toml"), projectFile: join(dir, "no-proj.toml"), env: {}, ...config },
  });
  return h;
};
const activeNames = (g: Harness) => g.graph().records.filter((r) => r.state === "active").map((r) => r.name);
const failedOf = (g: Harness, name: string) => g.graph().records.find((r) => r.name === name && r.state === "failed");

describe("模块图端到端（§4.2 启动序列公开面实证）", () => {
  it("拓扑：依赖者后激活；能力经 services 传递", async () => {
    const order: string[] = [];
    const a = fakeModule("a", {
      provides: ["a.x"],
      activate(ctx) { order.push("a"); ctx.provide("a.x", 42); },
    });
    const b = fakeModule("b", {
      dependsOn: ["a.x"],
      activate(ctx) {
        order.push("b");
        void ctx.services.get<number>("a.x").then((v) => order.push(`b got ${v}`));
      },
    });
    const g = await boot([b, a]); // 故意乱序传入
    expect(order.slice(0, 2)).toEqual(["a", "b"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toContain("b got 42");
    expect(activeNames(g)).toEqual(["a", "b"]);
  });

  it("回滚 + 级联降级：激活抛错模块的半成品贡献不入注册表，依赖者连带 failed", async () => {
    const good = fakeModule("good", { provides: ["good.x"], activate(ctx) { ctx.provide("good.x", 1); } });
    const bad = fakeModule("bad", {
      dependsOn: ["good.x"],
      provides: ["bad.y"],
      activate(ctx) {
        ctx.contribute.tool({ name: "bad__t", description: "x", parameters: {} as never, resolveExecution: () => Promise.reject(new Error("不应被调用")) });
        throw new Error("激活到一半炸了");
      },
    });
    const dependent = fakeModule("dependent", { dependsOn: ["bad.y"] });
    const g = await boot([good, bad, dependent]);
    expect(activeNames(g)).toEqual(["good"]);            // 无关模块不受牵连（§10 降级不阻断）
    expect(failedOf(g, "bad")?.failReason).toContain("炸了");
    expect(failedOf(g, "dependent")?.failReason).toContain("bad"); // 级联
    expect(g.graph().tools.list().map((t) => t.name)).not.toContain("bad__t"); // staged commit 回滚
  });

  it("启停交互：defaultEnabled=false 需显式 enable；disable 优先", async () => {
    const on = fakeModule("on");
    const off = fakeModule("off", { defaultEnabled: false });
    const g1 = await boot([on, off]);
    expect(activeNames(g1)).toEqual(["on"]);
    await g1.close();
    const g2 = await boot([on, off], { enableModules: ["off"] });
    expect(activeNames(g2).sort()).toEqual(["off", "on"]);
    await g2.close();
    const g3 = await boot([on, off], { enableModules: ["off"], disableModules: ["off"] });
    expect(activeNames(g3)).toEqual(["on"]); // disable 优先于 enable（§5.4）
  });

  it("保留槽冲突 → 静态失败；软环（互相 optional 能力）→ 双双激活", async () => {
    const evil = fakeModule("evil", { provides: ["provider:fake"] }); // provider: 是核心保留前缀
    const x = fakeModule("x", { dependsOn: [{ capability: "y.x", optional: true }], provides: ["x.x"] });
    const y = fakeModule("y", { dependsOn: [{ capability: "x.x", optional: true }], provides: ["y.x"] });
    const g = await boot([evil, x, y]);
    expect(failedOf(g, "evil")?.failReason).toContain("保留");
    expect(activeNames(g)).toEqual(["x", "y"]); // 软环合法（§5.2 规则 2：optional 不建边）
  });
});
