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
});
