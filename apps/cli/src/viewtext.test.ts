import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "@orosus/core";
import type { CommandUi, ModuleDefinition } from "@orosus/contracts/module";
import { createCliUi, type FullAppFace } from "./uiface.ts";

/** 密封 harness（M1 纪律：测试不碰真实 ~/.orosus——main.test.ts 同款）。 */
let dir: string;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});
const tmp = (name = "uiface"): string => (dir = mkdtempSync(join(tmpdir(), `orosus-${name}-`)));

const fakeApp = (): { app: FullAppFace; seen: Array<Record<string, unknown>> } => {
  const seen: Array<Record<string, unknown>> = [];
  const app: FullAppFace = {
    viewText: (title, text, opts) => seen.push({ title, text, opts }),
    insertAtCursor: (t) => seen.push({ insert: t }),
    showToast: (t) => seen.push({ toast: t }),
  };
  return { app, seen };
};

const probeModule = (capture: { ui?: CommandUi }): ModuleDefinition => ({
  name: "ui-probe",
  version: "0.0.1",
  description: "装配探针",
  api: 1,
  activate(ctx) {
    capture.ui = ctx.ui;
  },
});

const isolated = async (over: { commandUi?: CommandUi; modules?: ModuleDefinition[] } = {}) => {
  const d = tmp();
  return createHarness({
    cwd: d,
    ...(over.modules !== undefined ? { modules: over.modules } : {}),
    ...(over.commandUi !== undefined ? { commandUi: over.commandUi } : {}),
    secretsFile: join(d, "secrets.env"),
    diagDir: join(d, "logs"),
    sessionsDir: join(d, "sessions"),
    discovery: { userDir: join(d, "mods"), projectDir: join(d, "pmods"), trustFile: join(d, "trust.json") },
    config: { userFile: join(d, "config.toml"), projectFile: join(d, "proj.toml"), env: {} },
  });
};

describe("viewText 装配层（m5 T2——uiface 委托 + 内核属主标注 + 无头缺省丢弃）", () => {
  it("① 行模式（无全屏应用）：落 console 多行——标题行 + 逐行内容（降级不丢弃）", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ui = createCliUi({ question: async () => "", secretQuestion: async () => "", activeApp: () => undefined });
      ui.viewText!("便签", "第一行\n第二行");
      const lines = log.mock.calls.map((c) => c.join(" "));
      expect(lines[0]).toBe("== 便签 ==");
      expect(lines).toContain("第一行");
      expect(lines).toContain("第二行");
    } finally {
      log.mockRestore();
    }
  });

  it("② 全屏委托：title/text/opts 透传给 FullApp（含 owner——宿主路径不带）", () => {
    const { app, seen } = fakeApp();
    const ui = createCliUi({ question: async () => "", secretQuestion: async () => "", activeApp: () => app });
    ui.viewText!("便签", "内容", { layout: "full", owner: "note" });
    expect(seen[0]).toMatchObject({ title: "便签", text: "内容" });
    expect((seen[0] as { opts?: { layout?: string; owner?: string } }).opts).toMatchObject({ layout: "full", owner: "note" });
  });

  it("③ 内核属主标注（activate ownerTagUi）：模块经 ctx.ui 调 viewText 自动带 owner=模块名；宿主直调无 owner", async () => {
    const { app, seen } = fakeApp();
    const cli = createCliUi({ question: async () => "", secretQuestion: async () => "", activeApp: () => app });
    cli.viewText!("宿主窗", "h"); // 宿主路径（不经过内核包装）
    const cap: { ui?: CommandUi } = {};
    const h = await isolated({ commandUi: cli, modules: [probeModule(cap)] });
    cap.ui!.viewText!("模块窗", "m");
    const host = seen[0] as { title: string; opts?: { owner?: string } };
    const mod = seen[1] as { title: string; opts?: { owner?: string } };
    expect(host.title).toBe("宿主窗");
    expect(host.opts?.owner).toBeUndefined();
    expect(mod.title).toBe("模块窗");
    expect(mod.opts?.owner).toBe("ui-probe");
    await h.close();
  });

  it("④ 无头缺省（commandUi 未注入）：可选口缺省不存在（判空降级不炸）；核心四法仍 fail-closed", async () => {
    const cap: { ui?: CommandUi } = {};
    const h = await isolated({ modules: [probeModule(cap)] });
    expect(cap.ui!.viewText).toBeUndefined();
    expect(cap.ui!.notice).toBeUndefined();
    await expect(cap.ui!.choose("t", ["a"])).rejects.toThrow("无交互环境");
    await h.close();
  });
});

describe("notice 时长装配（m5 T3——menu 基座不丢第二参，行模式忽略时长）", () => {
	it("notice(text, opts) 透传到宿主 notice 出口；旧式单参调用 opts = undefined", () => {
		const calls: Array<[string, { durationMs?: number } | undefined]> = [];
		const ui = createCliUi({
			question: async () => "",
			secretQuestion: async () => "",
			notice: (t, opts) => calls.push([t, opts]),
			activeApp: () => undefined,
		});
		ui.notice!("旧式");
		ui.notice!("停八秒", { durationMs: 8000 });
		expect(calls[0]).toEqual(["旧式", undefined]);
		expect(calls[1]).toEqual(["停八秒", { durationMs: 8000 }]);
	});
});

describe("输入框注入两法装配（m5 T4——活 getter：全屏期委托、行模式读 undefined 静默丢弃）", () => {
	it("① insertText 全屏委托到 insertAtCursor；行模式读出来是 undefined", () => {
		const { app, seen } = fakeApp();
		const full = createCliUi({ question: async () => "", secretQuestion: async () => "", activeApp: () => app });
		full.insertText!("你好");
		expect(seen).toContainEqual({ insert: "你好" });
		const line = createCliUi({ question: async () => "", secretQuestion: async () => "", activeApp: () => undefined });
		expect(line.insertText).toBeUndefined();
		expect(line.attachImage).toBeUndefined();
	});

	it("② attachImage 委托宿主链路（app + path 透传）；未提供链路时读 undefined", () => {
		const { app } = fakeApp();
		const got: Array<[string, string]> = [];
		const full = createCliUi({
			question: async () => "",
			secretQuestion: async () => "",
			activeApp: () => app,
			attachImage: (a, path) => got.push([a === app ? "app" : "other", path]),
		});
		full.attachImage!("D:/x.png");
		expect(got).toEqual([["app", "D:/x.png"]]);
		const noLink = createCliUi({ question: async () => "", secretQuestion: async () => "", activeApp: () => app });
		expect(noLink.attachImage).toBeUndefined();
	});

	it("③ 内核 ownerTagUi 不拍平 getter：模块侧 ctx.ui 的注入两法随 activeApp 切换活起来（行模式装载、全屏期可用）", async () => {
		const { app } = fakeApp();
		let mode: "line" | "full" = "line";
		const cli = createCliUi({ question: async () => "", secretQuestion: async () => "", activeApp: () => (mode === "full" ? app : undefined) });
		const cap: { ui?: CommandUi } = {};
		const h = await isolated({ commandUi: cli, modules: [probeModule(cap)] });
		expect(cap.ui!.insertText).toBeUndefined(); // 装载期 = 行模式
		mode = "full"; // 进全屏（同一 commandUi 对象、同一内核包装）
		expect(typeof cap.ui!.insertText).toBe("function");
		expect(cap.ui!.viewText).toBeDefined();
		await h.close();
	});
});
