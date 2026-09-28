import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimContains, createWriteGate, normalizeClaimPath } from "./writegate.ts";

const cwd = mkdtempSync(join(tmpdir(), "orosus-gate-"));
const gate = (): ReturnType<typeof createWriteGate> => createWriteGate(cwd);
const paths = (...ps: string[]) => ({ paths: ps.map((p) => normalizeClaimPath(cwd, p)).map((n) => (n as { ok: true; path: string }).path), wholeRepo: false });

describe("写协调闸 T7（决策 24：报备归一 + 撞车排队 + 同血缘快败 + 整仓屏障 + 主对话写预约）", () => {
  it("⑱ 报备归一：通配符拒；逃出项目拒；win32 大小写折叠后 Docs/ 与 docs/ 同一报备；claimContains 目录边界", () => {
    expect(normalizeClaimPath(cwd, "src/**/*.ts").ok).toBe(false);
    expect(normalizeClaimPath(cwd, join(cwd, "..", "outside.txt")).ok).toBe(false);
    const a = normalizeClaimPath(cwd, "Docs/") as { ok: true; path: string };
    const b = normalizeClaimPath(cwd, "docs") as { ok: true; path: string };
    if (process.platform === "win32") expect(a.path).toBe(b.path); // 大小写折叠 → 同一报备
    expect(claimContains(b.path, b.path + "/a.txt")).toBe(true);
    expect(claimContains(b.path, b.path + "x/a.txt")).toBe(false); // 目录边界：docs 不含 docsx
    expect(claimContains(b.path, b.path)).toBe(true);
  });

  it("⑲ 撞车排队（冲突序——CX-10）+ 闸随结束释放：重叠后到者等待；不重叠并行；持闸者释放即放行队首；被停的排队者按失败收场", async () => {
    const g = gate();
    const a = paths("src/");
    const b = paths("src/a.ts"); // 重叠（包含）
    const c = paths("docs/");    // 不重叠
    await g.acquire("a1", a, []);          // 立即持闸
    await g.acquire("c1", c, []);          // 不重叠 → 并行持闸
    let bStarted = false;
    const waitB = g.acquire("b1", b, []).then(() => { bStarted = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(bStarted).toBe(false);          // 撞车 → 排队
    expect(g.snapshot().queue.map((w) => w.agentId)).toEqual(["b1"]);
    g.release("a1");                       // 持闸者结束 → 放行
    await waitB;
    expect(bStarted).toBe(true);
    g.release("b1");                       // 第一段清场（b1 已持 src/a.ts——不清场会挡住第二段的 a2）
    g.release("c1");
    // 被停的排队者：a2 持闸、b2 排队、b2 被停 → b2 的等待按失败收场（排队中的写单子不死等）
    await g.acquire("a2", a, []);
    const stopP = g.acquire("b2", b, []);
    const a3P = g.acquire("b3", paths("src/deep/"), []).catch(() => undefined); // 后到的也排队（catch 防未处理拒绝——release 移出时 reject）
    await new Promise((r) => setTimeout(r, 5));
    g.release("b2");                       // 被停（还在排队）——移出并 reject
    await expect(stopP).rejects.toThrow("已被停止");
    g.release("b3");                       // b3 一并被停（排队者结束都走 reject）
    await a3P;
    g.release("a2");
  });

  it("⑳ 同血缘撞车快败：持闸的/排队的正是排队者的先代 → 立即失败不排队（防父等孙、孙等父死锁），文案指路", async () => {
    const g = gate();
    await g.acquire("parent", paths("src/"), []);
    await expect(g.acquire("child", paths("src/x.ts"), ["parent"])).rejects.toThrow("上级代理");
    const g2 = gate();
    await g2.acquire("h", paths("docs/"), []);
    const kinQueued = g2.acquire("parent", paths("src/"), []);
    await new Promise((r) => setTimeout(r, 5)); // parent 在排队
    await expect(g2.acquire("child", paths("src/a.ts"), ["parent"])).rejects.toThrow("上级代理");
    g2.release("h");
    await kinQueued;
    g2.release("parent");
  });

  it("㉑ 整仓屏障与主对话写预约：整仓排队者在队首时后来的写者不插队；主对话写撞报备立即失败、不撞放行（含排队报备）", async () => {
    const g = gate();
    await g.acquire("h", paths("src/"), []);
    const wholeRepo = { paths: [] as string[], wholeRepo: true };
    let wStarted = false;
    const waitW = g.acquire("whole", wholeRepo, []).then(() => { wStarted = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(wStarted).toBe(false);          // 整仓者与 h 撞 → 排队
    let dStarted = false;
    const waitD = g.acquire("disjoint", paths("docs/"), []).then(() => { dStarted = true; }); // 不重叠但整仓者在等 → 不许插队
    await new Promise((r) => setTimeout(r, 5));
    expect(dStarted).toBe(false);
    g.release("h");
    await waitW;                           // h 结束 → 整仓者先上（队首）
    await new Promise((r) => setTimeout(r, 5));
    expect(dStarted).toBe(false);          // 整仓者还持着闸 → docs 写者继续等
    g.release("whole");
    await waitD;
    expect(dStarted).toBe(true);
    // 主对话写预约（disjoint 已放闸——此刻在册只剩 m1）
    g.release("disjoint");
    await g.acquire("m1", paths("src/"), []);
    const hit = g.checkMainWrite([join("src", "a.ts")]);
    expect(hit.ok).toBe(false);
    if (!hit.ok) expect(hit.error).toContain("m1");
    expect(g.checkMainWrite([join("docs", "b.txt")]).ok).toBe(true);
    g.release("m1");
  });

  it("㉑b CX-10 冲突序钉：先到的冲突排队者未启动时，不冲突的后来者先行持闸（非严格 FIFO——细粒度报备的并发意义，头注释同款口径）", async () => {
    const g = gate();
    await g.acquire("h", paths("src/"), []);             // 持闸：src/
    const waitB = g.acquire("b", paths("src/a.ts"), []); // 先到：与 h 冲突 → 排队
    await new Promise((r) => setTimeout(r, 5));
    let dStarted = false;
    const waitD = g.acquire("d", paths("docs/"), []).then(() => { dStarted = true; }); // 后到：与 h 不冲突
    await new Promise((r) => setTimeout(r, 5));
    expect(dStarted).toBe(true);                         // 后来者越过排队的 b 先行持闸——冲突序，非严格 FIFO
    expect(g.snapshot().queue.map((w) => w.agentId)).toEqual(["b"]);
    g.release("h");                                      // b 的冲突源消失 → 放行
    await waitB;
    await waitD;                                         // d 早已持闸（thèn 已 resolve）——清场对齐 ⑲ 风格
    g.release("b");
    g.release("d");
  });
});
