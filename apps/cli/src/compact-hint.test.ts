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

  it("② TTY 行模式 → 指示行经 liveview.activity 写出（含「上下文压缩中」）；h.prompt settle（返回/抛错）→ discard 擦除", async () => {
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
    expect(COMPACT_HINT).toContain("上下文压缩中"); // 2026-09-23 用户拍板文案（spinner/activity 同文案）
    calls.length = 0;
    await expect(
      withCompactHint("/compact", io, async () => { calls.push("run"); throw new Error("压缩失败"); }),
    ).rejects.toThrow("压缩失败");
    expect(calls).toEqual([`activity:${COMPACT_HINT}`, "run", "discard"]); // 失败同款擦除——指示行不残留
  });

  it("②b 全屏期 → fullscreen.enter/exit 钩子接管（activity 不写——spinner 专属形态承载进度）；settle 后 exit", async () => {
    const calls: string[] = [];
    const io = {
      isTTY: true,
      activity: (s: string): void => { calls.push(`activity:${s}`); },
      discard: (): void => { calls.push("discard"); },
      fullscreen: {
        enter: (text: string): void => { calls.push(`enter:${text}`); },
        exit: (): void => { calls.push("exit"); },
      },
    };
    await withCompactHint("/compact", io, async () => { calls.push("run"); return "ok"; });
    expect(calls).toEqual([`enter:${COMPACT_HINT}`, "run", "exit", "discard"]); // activity 零调用——全屏不直写流区
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
