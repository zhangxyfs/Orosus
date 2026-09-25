import { describe, it, expect } from "vitest";
import { computeMountClosure, computeUnmountClosure, type ModuleDepRow } from "./module-deps.ts";

const row = (name: string, provides: string[], dependsOn: string[], state: ModuleDepRow["state"] = "active"): ModuleDepRow =>
  ({ name, provides, dependsOn, state });

/** 链：a 提供 cap-a；b 硬依赖 cap-a；c 硬依赖 cap-b（c 经 b 传递依赖 a）。 */
const chain = () => [
  row("a", ["cap-a"], []),
  row("b", ["cap-b"], ["cap-a"]),
  row("c", ["cap-c"], ["cap-b"]),
];

describe("硬依赖联动闭包（T4/S1）", () => {
  it("卸载闭包：卸 a 含直接依赖方 b 与传递依赖方 c", () => {
    const r = computeUnmountClosure(["a"], chain(), []);
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.write].sort()).toEqual(["a", "b", "c"]);
  });

  it("挂载闭包：挂 b 补上未激活的硬依赖提供者 a；已激活的提供者不进写盘名单", () => {
    const rows = [
      row("b", ["cap-b"], ["cap-a"], "discovered"),
      row("a-off", ["cap-a"], [], "discovered"),
      row("z", ["cap-z"], [], "active"),
    ];
    const r1 = computeMountClosure(["b"], rows, []);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect([...r1.write].sort()).toEqual(["a-off", "b"]);
    const r2 = computeMountClosure(["b"], [...rows.filter((x) => x.name !== "a-off"), row("a-on", ["cap-a"], [], "active")], []);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.write).toEqual(["b"]); // 已激活提供者不写盘
  });

  it("可选依赖（? 后缀）不进闭包（挂卸两侧）", () => {
    const rows = [
      row("a", ["cap-a"], [], "discovered"),
      row("b-optional", ["cap-b"], ["cap-a?"], "discovered"),
    ];
    const um = computeUnmountClosure(["a"], [row("a", ["cap-a"], []), row("b-optional", ["cap-b"], ["cap-a?"])], []);
    expect(um.ok).toBe(true);
    if (um.ok) expect(um.write).toEqual(["a"]);
    const m = computeMountClosure(["b-optional"], rows, []);
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.write).toEqual(["b-optional"]); // 可选依赖不拉提供者
  });

  it("卸载闭包撞锁定模块 → 拒绝整次操作并点名（S1 拍板）", () => {
    const r = computeUnmountClosure(["a"], chain(), ["b"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blocked).toContain("无法卸载：a");
      expect(r.blocked).toContain("b（锁定）");
      expect(r.blocked).toContain("硬依赖");
    }
  });

  it("挂载闭包撞锁定模块（硬依赖的提供者锁定且未激活）→ 同样拒绝（S1 保守对称）", () => {
    const rows = [
      row("b", ["cap-b"], ["cap-a"], "discovered"),
      row("a", ["cap-a"], [], "discovered"),
    ];
    const r = computeMountClosure(["b"], rows, ["a"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blocked).toContain("无法挂载：b");
      expect(r.blocked).toContain("a（锁定）");
    }
  });
});

describe("卸载闭包的降级态收编（code-review 修复：failed 依赖者也写盘）", () => {
  it("依赖方处于 failed（级联降级态、enabled 仍 true）→ 照样进闭包写盘（消除降级噪音）", () => {
    const rows = [
      row("a", ["cap-a"], []),
      row("b", ["cap-b"], ["cap-a"], "failed"), // 事故后常态：被降级但 enabled=true
      row("c-off", ["cap-c"], ["cap-a"], "discovered"), // 已停用：无需再写
    ];
    const r = computeUnmountClosure(["a"], rows, []);
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.write].sort()).toEqual(["a", "b"]); // failed 收编、discovered 不收
  });
});
