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
