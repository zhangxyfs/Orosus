import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineModule, type ModuleDefinition, type UiTarget } from "@orosus/contracts/module";
import { InMemorySessionStore } from "../session/memory.ts";
import { loadModules } from "./kernel.ts";
import { createHarness } from "../index.ts";
import { fakeModule, fakeProviderModule } from "@orosus/testing";
import type { DiagSink, DiagRecord } from "../diag/logger.ts";

const sink = (): DiagSink & { records: DiagRecord[] } => {
  const records: DiagRecord[] = [];
  return { records, write: (r) => void records.push(r), flush: () => Promise.resolve(), close: () => Promise.resolve() };
};

const mod = (name: string, extra: Partial<ModuleDefinition>): ModuleDefinition =>
  defineModule({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...extra });

/** uiTarget 适用面矩阵（设计 §11.2）：行 = uiTarget 声明，列 = 宿主 hostUi；✓ = 进入模块图。 */
const MATRIX: Record<UiTarget, Record<"tui" | "gui" | "headless", boolean>> = {
  tui: { tui: true, gui: false, headless: false },
  gui: { tui: false, gui: true, headless: false },
  all: { tui: true, gui: true, headless: true },
};

describe("uiTarget 界面适用面（设计 §11）", () => {
  it("① 3×3 矩阵：不匹配宿主不 activate、不进 records；匹配宿主照常激活", async () => {
    for (const t of ["tui", "gui", "all"] as const) {
      for (const hostUi of ["tui", "gui", "headless"] as const) {
        let activated = false;
        const m = mod("visor-mod", { uiTarget: t, activate() { activated = true; } });
        const g = await loadModules({
          defs: [{ def: m, source: "builtin" }],
          cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
          ...(hostUi !== "headless" ? { hostUi } : {}), // headless = 缺省（嵌入方与既有测试行为不变）
        });
        const visible = g.audit().some((a) => a.name === "visor-mod");
        expect(visible, `${t} × ${hostUi}`).toBe(MATRIX[t][hostUi]);
        expect(activated, `${t} × ${hostUi}`).toBe(MATRIX[t][hostUi]);
        await g.dispose();
      }
    }
  });

  it("② 非法 uiTarget 值 = 静态校验失败（state=failed + failReason 含 uiTarget），不静默等同 all", async () => {
    const m = mod("bad-target", { uiTarget: "desktop" as UiTarget });
    const g = await loadModules({
      defs: [{ def: m, source: "builtin" }],
      cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
    });
    const entry = g.audit().find((a) => a.name === "bad-target")!;
    expect(entry.state).toBe("failed");
    expect(entry.failReason ?? "").toContain("uiTarget");
    await g.dispose();
  });

  it("③ 配置 enabled:true 不能强行挂载被滤模块（enabled 只在通过适用面过滤后参与求值）", async () => {
    const m = mod("gui-only", { uiTarget: "gui" });
    const g = await loadModules({
      defs: [{ def: m, source: "builtin" }],
      cli: {}, sections: new Map([["gui-only", { enabled: true }]]),
      session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s", hostUi: "tui",
    });
    expect(g.audit().some((a) => a.name === "gui-only")).toBe(false);
    await g.dispose();
  });

  it("④ 被滤模块从 audit() 与 catalogJson() 双面消失（设置页/启动器同一份 records）", async () => {
    const g = await loadModules({
      defs: [{ def: mod("gui-only", { uiTarget: "gui" }), source: "builtin" }, { def: mod("plain-mod", {}), source: "builtin" }],
      cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s", hostUi: "tui",
    });
    expect(g.audit().some((a) => a.name === "gui-only")).toBe(false);
    expect(g.catalogJson()).not.toContain("gui-only");
    expect(g.catalogJson()).toContain("plain-mod");
    await g.dispose();
  });

  it("⑤ 待信任第三方（pending-confirm 桶）走同一谓词：不适用宿主不经侧门显示", async () => {
    const g = await loadModules({
      defs: [{ def: mod("plain-mod", {}), source: "builtin" }],
      blocked: [{ def: mod("tui-third", { uiTarget: "tui" }), source: "local", reason: "unconfirmed" }],
      cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s", hostUi: "gui",
    });
    expect(g.audit().some((a) => a.name === "tui-third")).toBe(false); // 不进 pending-confirm 列表
    await g.dispose();
  });

  it("⑥ required + 被滤：不阻断启动、降级 required-host-filtered 告警（宿主过滤是平台事实，非配置矛盾）", async () => {
    const s = sink();
    const g = await loadModules({
      defs: [{ def: mod("gui-only", { uiTarget: "gui" }), source: "builtin" }],
      cli: {}, sections: new Map([["gui-only", { required: true }]]),
      session: new InMemorySessionStore(), sink: s, spillDir: "/tmp/s", hostUi: "tui",
    });
    expect(g.audit().some((a) => a.name === "gui-only")).toBe(false);
    expect(s.records.some((r) => r.code === "kernel.config.required-host-filtered")).toBe(true);
    await g.dispose();
  });
});

describe("uiTarget × harness reload（设计 §11.3）", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("⑦ 同一 harness reload 前后模块集合一致：hostUi 透传 reload，不因回落缺省而跳变", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-uitarget-"));
    dirs.push(dir);
    const script = [[{ type: "text/delta" as const, text: "x" }, { type: "finish" as const, kind: "stop" as const }]];
    const guiOnly = fakeModule("gui-only", { uiTarget: "gui", activate() {} });
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      modules: [fakeProviderModule("fake", script), guiOnly],
      config: { userFile: join(dir, "no-user.toml"), projectFile: join(dir, "no-proj.toml"), env: {}, cliOverrides: { model: "fake/m" } },
      hostUi: "tui",
    });
    const before = h.graph().audit().map((a) => a.name);
    expect(before).not.toContain("gui-only");
    expect(before).toContain("provider-fake");
    await h.reload();
    const after = h.graph().audit().map((a) => a.name);
    expect(after).toEqual(before); // reload 不回落 headless、不复活被滤模块、不丢匹配模块
    await h.close();
  });
});
