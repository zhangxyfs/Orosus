import { describe, it, expect } from "vitest";
import { COMPACT_HINT, isCompactCommand, withCompactHint } from "./compact-hint.ts";

describe("/compact 进度指示（TUI 批 T7——压缩调研 P1 残余）", () => {
  it("① 归一化变体（\" /compact \"、\"/ compact\"、全角空格）均命中指示行；非 /compact 行不写", () => {
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand(" /compact ")).toBe(true);
    expect(isCompactCommand("/ compact")).toBe(true);
    expect(isCompactCommand("　/compact ")).toBe(true); // 全角空格 + 末尾空格变体（core 归一化同款可解析）
    expect(isCompactCommand("/compact  now")).toBe(true); // 连续空白折叠后仍命中
    expect(isCompactCommand("/compactx")).toBe(false); // 严格边界（v1.6 收紧）——未知命令不误写且无处擦除
    expect(isCompactCommand("/help")).toBe(false);
    expect(isCompactCommand("聊聊 /compact 的用法")).toBe(false); // 非行首不命中
    expect(isCompactCommand("")).toBe(false);
  });

  it("② TTY → 指示行经 liveview.activity 写出（含「正在压缩」）；h.prompt settle（返回/抛错）→ discard 擦除", async () => {
    const calls: string[] = [];
    const io = {
      isTTY: true,
      activity: (s: string): void => { calls.push(`activity:${s}`); },
      discard: (): void => { calls.push("discard"); },
    };
    const ok = await withCompactHint("/compact", io, async () => { calls.push("run"); return "结果串"; });
    expect(ok).toBe("结果串");
    // 序：指示行 → 执行 → 擦除（结果由调用方 console 输出——不经 liveview，机制⑤ v1.8）
    expect(calls).toEqual([`activity:${COMPACT_HINT}`, "run", "discard"]);
    expect(COMPACT_HINT).toContain("正在压缩");
    calls.length = 0;
    await expect(
      withCompactHint("/compact", io, async () => { calls.push("run"); throw new Error("压缩失败"); }),
    ).rejects.toThrow("压缩失败");
    expect(calls).toEqual([`activity:${COMPACT_HINT}`, "run", "discard"]); // 失败同款擦除——指示行不残留
  });

  it("③ 非 TTY → 零指示输出（脚本 stdout 干净）", async () => {
    const calls: string[] = [];
    const io = {
      isTTY: false,
      activity: (s: string): void => { calls.push(`activity:${s}`); },
      discard: (): void => { calls.push("discard"); },
    };
    const ok = await withCompactHint("/compact", io, async () => "ok");
    expect(ok).toBe("ok");
    expect(calls).toEqual([]); // activity/discard 均不触达——管道零字节变化（硬约束 3）
    const ttyCalls: string[] = [];
    const ttyIo = {
      isTTY: true,
      activity: (s: string): void => { ttyCalls.push(`activity:${s}`); },
      discard: (): void => { ttyCalls.push("discard"); },
    };
    await withCompactHint("/compactx", ttyIo, async () => "ok"); // TTY 但归一化未命中 → 同样零输出
    expect(ttyCalls).toEqual([]);
  });
});
