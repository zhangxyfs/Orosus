import { describe, it, expect } from "vitest";
import { InMemorySessionStore } from "./memory.ts";

describe("InMemorySessionStore", () => {
  it("append 自动补 v/seq/ts/parentId 链（§6.1）", async () => {
    const s = new InMemorySessionStore();
    const header = await s.append("session/header", { format: 1, cwd: "/repo", parentSession: null });
    const msg = await s.append("user/message", { content: [{ kind: "text", text: "hi" }] });
    expect(header.v).toBe(1);
    expect(header.seq).toBe(1);
    expect(header.parentId).toBeNull();
    expect(msg.seq).toBe(2);
    expect(msg.parentId).toBe(header.id); // parentId 默认 = 上一条
    expect(msg.id).not.toBe(header.id);
  });

  it("seq 单调递增；all() 按 seq 返回", async () => {
    const s = new InMemorySessionStore();
    await s.append("a");
    await s.append("b");
    await s.append("c");
    const all = await s.all();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all.map((e) => e.type)).toEqual(["a", "b", "c"]);
  });

  it("flush/close 是安全 no-op", async () => {
    const s = new InMemorySessionStore();
    await s.append("x");
    await expect(s.flush()).resolves.toBeUndefined();
    await expect(s.close()).resolves.toBeUndefined();
  });

  it("CS-13（2026-09-28 code review）：close 后 append 拒绝 store closed——与 jsonl/sqlite 后端语义对齐（旧实现照常成功，替身跑出的测试会掩盖「关闭后仍写」类 bug）；all() 仍可读、重复 close 幂等", async () => {
    const s = new InMemorySessionStore();
    await s.append("x");
    await s.close();
    await expect(s.append("y")).rejects.toThrow(/store closed/); // 同 jsonl.ts/sqlite.ts 的拒绝语义与文案
    expect((await s.all()).map((e) => e.type)).toEqual(["x"]); // 读面不受影响
    await expect(s.close()).resolves.toBeUndefined(); // 幂等
  });
});
