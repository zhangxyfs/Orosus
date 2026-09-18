import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore, type Harness } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { CommandUi } from "@orosus/contracts/module";
import { startupGate } from "./startup.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const agreeUi: CommandUi = { ask: async () => "", choose: async (_t, items) => items[0]!, confirm: async () => true };

const makeH = async (): Promise<Harness> => {
  dir = mkdtempSync(join(tmpdir(), "orosus-startup-"));
  return createHarness({
    store: new InMemorySessionStore(),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    modules: [fakeProviderModule("fake", [])],
    config: { userFile: join(dir, "no-user.toml"), projectFile: join(dir, "no-proj.toml"), env: {} },
  });
};

describe("首启引导接线（模型发现 T0——M3 T9 欠账：装配层用例，拿掉 startup 门该序断言必红）", () => {
  it("① model 未配置 + TTY + 确认同意 → h.prompt 依序收到 /provider 与 /reload，复检回显已生效", async () => {
    const h = await makeH();
    const calls: string[] = [];
    let model: string | undefined; // 向导"写入"后转绿（T4 落地后由 setModel 真实发生）
    const hSeq: Harness = {
      ...h,
      prompt: async (text: string) => {
        calls.push(text);
        if (text === "/provider") { model = "fake"; return "向导输出"; }
        return ""; // /reload 等其余调用不进断言
      },
    };
    const out = await startupGate({ h: hSeq, ui: agreeUi, readModel: () => model, isTty: true });
    expect(calls).toEqual(["/provider", "/reload"]); // 依序转发（装配层断言）
    expect(out).toContain("向导输出");
    expect(out).toContain("✓ 配置已生效"); // 复检转绿
    await h.close();
  });

  it("② 两态分别零调用：model 已配置（TTY）不触发；model 未配置但非 TTY 不触发（四轮 P3③）", async () => {
    const h1 = await makeH();
    const calls: string[] = [];
    const hSeq: Harness = { ...h1, prompt: async (text: string) => { calls.push(text); return ""; } };
    expect(await startupGate({ h: hSeq, ui: agreeUi, readModel: () => "fake/m", isTty: true })).toBeUndefined();
    expect(calls).toEqual([]); // 态一：已配置
    const h2 = await makeH();
    const calls2: string[] = [];
    const hSeq2: Harness = { ...h2, prompt: async (text: string) => { calls2.push(text); return ""; } };
    expect(await startupGate({ h: hSeq2, ui: agreeUi, readModel: () => undefined, isTty: false })).toBeUndefined();
    expect(calls2).toEqual([]); // 态二：非 TTY
    await h1.close();
    await h2.close();
  });
});
