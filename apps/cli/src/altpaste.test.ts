import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { attachAltVPaste } from "./altpaste.ts";
import { PASTE_EMPTY } from "./paste.ts";

/** fake 按键源与宿主面：emitKey 模拟 readline keypress 多播；w 收集写面；faces 计数调用。 */
const fakeIo = (opts: { img?: { file: string } | undefined; isTTY?: boolean } = {}) => {
  const input = new EventEmitter();
  const w: string[] = [];
  const calls = { paste: 0, clear: 0, pending: [] as string[] };
  attachAltVPaste({
    input,
    isTTY: opts.isTTY ?? true,
    pasteImage: async () => {
      calls.paste++;
      return opts.img;
    },
    write: (s) => w.push(s),
    clearInputLine: () => {
      calls.clear++;
    },
    setPendingImage: (f) => {
      calls.pending.push(f);
    },
  });
  const emitKey = (k: { name?: string; meta?: boolean } | undefined): void => {
    input.emit("keypress", "", k);
  };
  return { input, w, calls, emitKey };
};

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("Alt+V 按键粘贴（TUI 批 T5——V.2 移入项）", () => {
  it("① 输入等行态按 Alt+V → 触发 pasteImage（注入面计数）+ 提示行 + pendingImage 置位；其余按键放行", async () => {
    const { w, calls, emitKey } = fakeIo({ img: { file: "D:\\home\\tmp\\paste-1.png" } });
    emitKey({ name: "v", meta: false }); // 裸 v——不触发
    emitKey({ name: "x", meta: true }); // Alt+X——不触发
    await flush();
    expect(calls.paste).toBe(0);
    emitKey({ name: "v", meta: true }); // Alt+V
    await flush();
    expect(calls.paste).toBe(1);
    expect(calls.clear).toBe(1); // 行残留清理（readline 对未绑定 meta 序列可能残留控制字符）
    expect(calls.pending).toEqual(["D:\\home\\tmp\\paste-1.png"]);
    const out = w.join("");
    expect(out).toContain("[已粘贴图片: paste-1.png]"); // basename——与 /paste 提示同源
    expect(out).not.toContain("> [已粘贴图片"); // 提示独立成行、不带 `> ` 前缀（v1.8 B3）
    expect(out.endsWith("\n> ")).toBe(true); // 结尾重绘提示符
  });
  it("② 剪贴板无图 → 同 /paste 无图提示，输入行清空重绘、进程不崩", async () => {
    const { w, calls, emitKey } = fakeIo({ img: undefined });
    emitKey({ name: "v", meta: true });
    await flush();
    expect(calls.paste).toBe(1);
    expect(calls.pending).toEqual([]); // 无图不置位
    expect(w.join("")).toContain(PASTE_EMPTY);
  });
  it("③ 非 TTY → 监听器不挂（按键零处理——退化矩阵：无 TTY 无按键流）", () => {
    const { input } = fakeIo({ isTTY: false });
    expect(input.listenerCount("keypress")).toBe(0);
  });
});
