import { describe, it, expect } from "vitest";
import { createReadlineUi, createSilenceableOutput } from "./menu.ts";

describe("readline 版 CommandUi（menu 组件，D35/D38 语言约定注记）", () => {
  it("choose：编号选择，无效序号重问后命中", async () => {
    const answers = ["99", "2"];
    const ui = createReadlineUi({ question: async () => answers.shift() ?? "", secretQuestion: async () => "" });
    const picked = await ui.choose("选择平台", ["甲", "乙", "丙"]);
    expect(picked).toBe("乙");
  });
  it("choose：TTY 引擎注入面——pick 面 reject 统一映射「已取消（Esc）」（机制③统一文案的装配层钉，硬约束 1）", async () => {
    const ui = createReadlineUi({
      // question 恒给合法序号：未接 pick 面的旧实现会正常返回（断言随之失败）而非死循环重问
      question: async () => "1",
      secretQuestion: async () => "",
      pick: async () => {
        throw new Error("注入的取消");
      },
    });
    await expect(ui.choose("选择平台", ["甲"])).rejects.toThrow("已取消（Esc）");
  });
  it("confirm：y/Y 为真，其余为假；ask 原样返回 trim 后输入；askSecret 走掩码询问口", async () => {
    const answers = ["y", "n", "  hello  "];
    const secrets: string[] = [];
    const ui = createReadlineUi({ question: async () => answers.shift() ?? "", secretQuestion: async (q) => { secrets.push(q); return "  sk-x  "; } });
    expect(await ui.confirm("继续？")).toBe(true);
    expect(await ui.confirm("继续？")).toBe(false);
    expect(await ui.ask("名字")).toBe("hello");
    expect(await ui.askSecret("粘贴 KEY")).toBe("sk-x");
    expect(secrets).toEqual(["粘贴 KEY"]);
  });
});

describe("可静默输出代理（密钥输入无回显——逐键 * 在真实 Windows 终端层碎成孤星，走查改盲输）", () => {
  it("silence on：一切回显（含 ANSI 刷新/控制序列/换行）全吞；off 恢复透传", async () => {
    const out: string[] = [];
    const w = createSilenceableOutput({ write: (s) => void out.push(s) });
    const push = (s: string): Promise<void> => new Promise((r) => w.write(s, () => r()));
    await push("正常");
    expect(out).toEqual(["正常"]);
    w.silence(true);
    await push("sk-secret");
    await push("\x1b[1G\x1b[0J");
    await push("a\nb");
    expect(out).toEqual(["正常"]); // 静默期零输出
    w.silence(false);
    await push("恢复");
    expect(out).toEqual(["正常", "恢复"]);
  });
});

describe("ask/askSecret/confirm 的 Esc 取消（TUI 批 T3——B5「Esc 取消」带内抛错 fail-closed）", () => {
  it("① ask 期间宿主面抛 Esc → 原样穿透「已取消（Esc）」（D35 拒绝式同族）；正常输入路径不变", async () => {
    const ui = createReadlineUi({
      question: async (q) => {
        if (q.startsWith("会取消")) throw new Error("已取消（Esc）");
        return "  hello  ";
      },
      secretQuestion: async () => "",
    });
    await expect(ui.ask("会取消的问题")).rejects.toThrow("已取消（Esc）");
    expect(await ui.ask("名字")).toBe("hello");
  });
  it("② askSecret 盲输态 Esc → 同款抛错（静默代理开/关仍成对）；方向键等 CSI 序列不取消（吞掉）", async () => {
    // 宿主盲输问题面的测试替身（main.ts secretQuestion 同款模式）：静默开 → watchEsc 多播
    // Esc 监听（abort 表达）→ 成行 resolve / abort reject → finally 静默关
    const { Readable } = await import("node:stream");
    const { watchEsc } = await import("./keys.ts");
    const input = new Readable({ read() {} });
    const silences: boolean[] = [];
    const echo = createSilenceableOutput({ write: () => {} });
    const rawSilence = echo.silence.bind(echo);
    echo.silence = (on: boolean): void => {
      silences.push(on);
      rawSilence(on);
    };
    const secretQuestion = async (): Promise<string> => {
      echo.silence(true);
      try {
        return await new Promise<string>((resolve, reject) => {
          const ac = new AbortController();
          const stop = watchEsc(input, () => ac.abort(), { escWindowMs: 0 });
          const onData = (buf: Buffer): void => {
            if (buf.includes(0x0d)) settle(() => resolve("sk"));
          };
          const onAbort = (): void => settle(() => reject(new Error("已取消（Esc）")));
          const settle = (done: () => void): void => {
            stop();
            input.removeListener("data", onData);
            ac.signal.removeEventListener("abort", onAbort);
            done();
          };
          input.on("data", onData);
          ac.signal.addEventListener("abort", onAbort);
        });
      } finally {
        echo.silence(false); // 取消路径同样成对恢复（main.ts finally 同款）
      }
    };
    const ui = createReadlineUi({ question: async () => "", secretQuestion });
    // 方向键 CSI 被解析器吞掉——不取消；随后正常成行
    const pA = ui.askSecret("KEY");
    input.push(Buffer.from("\x1b[A"));
    await new Promise((r) => setTimeout(r, 5)); // 假想 Esc 窗口过去也无事件
    input.push(Buffer.from("sk\r"));
    await expect(pA).resolves.toBe("sk");
    // 单 Esc（30ms 窗口判出）→ 取消
    const pB = ui.askSecret("KEY");
    input.push(Buffer.from("\x1b"));
    await expect(pB).rejects.toThrow("已取消（Esc）");
    expect(silences).toEqual([true, false, true, false]); // 两次盲输静默开/关成对
  });
  it("③ confirm 的 Esc → false（非确认语义，不抛错）；正常 y 路径不变", async () => {
    const ui = createReadlineUi({
      question: async (q) => {
        if (q.startsWith("危险")) throw new Error("已取消（Esc）");
        return "y";
      },
      secretQuestion: async () => "",
    });
    expect(await ui.confirm("危险操作？")).toBe(false); // Esc = 非确认（fail-closed 方向）
    expect(await ui.confirm("继续？")).toBe(true);
  });
});
