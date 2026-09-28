import { describe, it, expect } from "vitest";
import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import { resolveTopo } from "./topo.ts";

const mod = (name: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition =>
  defineModule({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...extra });

describe("能力解析与拓扑排序（§5.2 规则 2）", () => {
  it("硬依赖建边：提供者在消费者之前；同级按字典序", () => {
    const shell = mod("tool-shell", { dependsOn: ["fs"] });
    const fs = mod("tool-fs", { provides: ["fs"] });
    const aaa = mod("aaa");
    const { order, degraded } = resolveTopo({ defs: [shell, fs, aaa], disabled: new Set() });
    expect(degraded).toEqual([]);
    const names = order.map((m) => m.name);
    expect(names.indexOf("tool-fs")).toBeLessThan(names.indexOf("tool-shell"));
    expect(names[0]).toBe("aaa"); // 无依赖同级：aaa 字典序最小
  });

  it("同一能力两个激活提供者 → 冲突双方降级，依赖者级联降级", () => {
    const a = mod("a-fs", { provides: ["fs"] });
    const b = mod("b-fs", { provides: ["fs"] });
    const c = mod("c-consumer", { dependsOn: ["fs"] });
    const { order, degraded } = resolveTopo({ defs: [a, b, c], disabled: new Set() });
    expect(order).toEqual([]);
    const names = degraded.map((d) => d.name).sort();
    expect(names).toEqual(["a-fs", "b-fs", "c-consumer"]);
    expect(degraded.find((d) => d.name === "a-fs")!.reason).toContain("冲突");
    expect(degraded.find((d) => d.name === "c-consumer")!.reason).toContain("fs");
  });

  it("硬环 → 环上模块全部降级，审计带整条环", () => {
    const a = mod("a", { provides: ["a.x"], dependsOn: ["b.y"] });
    const b = mod("b", { provides: ["b.y"], dependsOn: ["a.x"] });
    const { order, degraded } = resolveTopo({ defs: [a, b], disabled: new Set() });
    expect(order).toEqual([]);
    expect(degraded.map((d) => d.name).sort()).toEqual(["a", "b"]);
    expect(degraded[0]!.reason).toContain("环");
  });

  it("CK-15 回归钉：两环之间的过路节点不再误标环上——c（环 a↔b 的下游、环 p↔q 的上游）按级联降级，环描述不含 c（降级集合不变）", () => {
    const a = mod("a", { provides: ["a.x"], dependsOn: ["b.y"] });
    const b = mod("b", { provides: ["b.y"], dependsOn: ["a.x"] });
    const c = mod("c", { provides: ["c.z"], dependsOn: ["a.x"] }); // 过路节点：依赖环1、喂环2——旧迭代剔除法永不剔它
    const p = mod("p", { provides: ["p.w"], dependsOn: ["c.z", "q.v"] });
    const q = mod("q", { provides: ["q.v"], dependsOn: ["p.w"] });
    const { order, degraded } = resolveTopo({ defs: [a, b, c, p, q], disabled: new Set() });
    expect(order).toEqual([]);
    expect(degraded.map((d) => d.name).sort()).toEqual(["a", "b", "c", "p", "q"]); // 降级集合不变（过路节点由级联步兜住）
    expect(degraded.find((d) => d.name === "c")!.reason).toContain("级联"); // 旧实现：c 被记「硬循环依赖（环上模块全部降级）」——文案失实
    expect(degraded.find((d) => d.name === "c")!.reason).not.toContain("环");
    const cyc = degraded.find((d) => d.name === "a")!.reason;
    expect(cyc).toContain("环");
    expect(cyc).not.toContain("→ c"); // 环描述不把过路节点编成环成员（误导排障）
    expect(cyc).not.toContain("c →");
  });

  it("软环合法：optional 不建边", () => {
    const git = mod("git", { provides: ["git"], dependsOn: [{ capability: "github.pr", optional: true }] });
    const github = mod("github", { provides: ["github.pr"], dependsOn: ["git"] });
    const { order, degraded } = resolveTopo({ defs: [git, github], disabled: new Set() });
    expect(degraded).toEqual([]);
    const names = order.map((m) => m.name);
    expect(names.indexOf("git")).toBeLessThan(names.indexOf("github"));
  });

  it("被禁用模块不参与能力解析：其 provides 视为不存在，依赖者降级（§5.4）", () => {
    const fs = mod("tool-fs", { provides: ["fs"] });
    const shell = mod("tool-shell", { dependsOn: ["fs"] });
    const { order, degraded } = resolveTopo({ defs: [fs, shell], disabled: new Set(["tool-fs"]) });
    expect(order.map((m) => m.name)).toEqual([]);
    expect(degraded.map((d) => d.name).sort()).toEqual(["tool-fs", "tool-shell"]);
    expect(degraded.find((d) => d.name === "tool-shell")!.reason).toContain("tool-fs");
  });
});
