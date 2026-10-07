import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { Harness } from "@orosus/core";
import { memoryImportResultText, readPeersConfig, runMemoryImportChoose, runMemorySetting, writePeersConfigKey, type MemoryImportDeps } from "./peers-settings.ts";
import { settingsItems } from "./settings-ui.ts";

let dir = "";
afterEach(() => { if (dir !== "") rmSync(dir, { recursive: true, force: true }); dir = ""; });
const tmpCfg = (): string => { dir = mkdtempSync(join(tmpdir(), "peers-set-")); const f = join(dir, "config.toml"); writeFileSync(f, ""); return f; };

describe("peers 设置面（m5-peers T6b）", () => {
  it("① 两键读写往返：缺省关（缺键 = 关，D13）；写 true 读回；再写 false 回关", () => {
    const f = tmpCfg();
    expect(readPeersConfig(f)).toEqual({ workspaceMemory: false, sessionPeers: false });
    writePeersConfigKey("workspaceMemory", true, f);
    writePeersConfigKey("sessionPeers", true, f);
    expect(readPeersConfig(f)).toEqual({ workspaceMemory: true, sessionPeers: true });
    writePeersConfigKey("sessionPeers", false, f);
    expect(readPeersConfig(f).sessionPeers).toBe(false);
    // 布尔裸值行级写（modules.d/tool-peers.toml——路由内建）
    const toml = readFileSync(join(dir, "modules.d", "tool-peers.toml"), "utf8");
    expect(toml).toContain("[tool-peers]");
    expect(toml).toContain("sessionPeers = false");
  });

  it("② 切换流：回车即切换写键，返回人话结果（工作区记忆 关→开）", async () => {
    const f = tmpCfg();
    const res = await runMemorySetting(async (_t, items) => items[0]!, f);
    expect(res).toMatchObject({ kind: "toggle", key: "workspaceMemory", value: true });
    expect(res?.kind === "toggle" && res.message).toContain("工作区记忆");
    expect(readPeersConfig(f).workspaceMemory).toBe(true);
  });

  it("③ 切换流：会话感知 开→关（先写 true）；Esc（空串）= undefined", async () => {
    const f = tmpCfg();
    writePeersConfigKey("sessionPeers", true, f);
    const res = await runMemorySetting(async (_t, items) => items[1]!, f);
    expect(res).toMatchObject({ kind: "toggle", key: "sessionPeers", value: false });
    expect(readPeersConfig(f).sessionPeers).toBe(false);
    const esc = await runMemorySetting(async () => "", f);
    expect(esc).toBeUndefined();
  });

  it("③b 第三项「记忆导入」→ { kind: import }（不写盘；浏览窗不走设置入口——走查修订二/三)", async () => {
    const f = tmpCfg();
    const res = await runMemorySetting(async (_t, items) => items[2]!, f);
    expect(res).toEqual({ kind: "import" });
    expect(readPeersConfig(f)).toEqual({ workspaceMemory: false, sessionPeers: false });
  });

  it("③c 导入选择段（走查八-④ 开关形态）：源行/全部/整理开关行；开关开后所有路径走整理；Esc/空货源", async () => {
    const deps: MemoryImportDeps = {
      detect: () => [
        { id: "claude-code", label: "Claude Code", count: 12 },
        { id: "zcode", label: "ZCode", count: 37 },
        { id: "qwen", label: "qwen-code", count: 0 },   // 无货不列
      ],
      run: async () => ({ imported: 0, skipped: 0, merged: 0 }),   // 选择段不触 run
    };
    // 单源导入（默认整理关）
    const single = await runMemoryImportChoose(async (_t, items) => items[0]!, deps);
    expect(single).toEqual({ ids: ["claude-code"], organize: false });
    // 全部导入（倒数第二项——qwen 0 条被滤）
    const all = await runMemoryImportChoose(async (_t, items) => items[items.length - 2]!, deps);
    expect(all).toEqual({ ids: ["claude-code", "zcode"], organize: false });
    // 开关行（末项）：切换后菜单刷新（✓ 移位），再选源行 = organize true（单源也走整理——走查八-④）
    const seq = ["last", "first"];
    let i = 0;
    const orgSingle = await runMemoryImportChoose(async (_t, items) => items[seq[i++] === "last" ? items.length - 1 : 0]!, deps);
    expect(orgSingle).toEqual({ ids: ["claude-code"], organize: true });
    // Esc = undefined；无货源 = "empty"（不弹菜单）
    expect(await runMemoryImportChoose(async () => "", deps)).toBeUndefined();
    const emptyDeps: MemoryImportDeps = { detect: () => [{ id: "x", label: "X", count: 0 }], run: async () => ({ imported: 0, skipped: 0, merged: 0 }) };
    expect(await runMemoryImportChoose(async () => {
      throw new Error("不该弹菜单");
    }, emptyDeps)).toBe("empty");
  });

  it("③d 导入结果人话：机械档不报整理；整理档报「模型整理 N 条」；全重复专句", () => {
    expect(memoryImportResultText({ imported: 10, skipped: 2, merged: 0 })).toContain("已导入 10 条记忆");
    expect(memoryImportResultText({ imported: 10, skipped: 2, merged: 0 })).not.toContain("模型整理");
    expect(memoryImportResultText({ imported: 31, skipped: 3, merged: 18 })).toContain("模型整理 18 条");
    expect(memoryImportResultText({ imported: 0, skipped: 5, merged: 0 })).toContain("全部与现有记忆重复");
  });

  it("④ settingsItems 动态追加：tool-peers active 才含「记忆」；discovered/缺席不含；既有十二项序位不乱（T3 语言行 + m5-update-check 更新检查行）", () => {
    const fakeH = (entries: { name: string; state: string }[]) =>
      ({ graph: () => ({ audit: () => entries }) }) as unknown as Harness;
    const withPeers = settingsItems(fakeH([{ name: "tool-peers", state: "active" }]));
    expect(withPeers).toHaveLength(13) // m5-update-check 加「更新检查」行后 13（含记忆动态项）;
    expect(withPeers[11]).toContain("更新检查"); // m5-update-check：语言行占 10 后更新检查随挪 11
    expect(withPeers[12]).toContain("记忆"); // 更新检查行后记忆随挪 12
    expect(settingsItems(fakeH([{ name: "tool-peers", state: "discovered" }])).some(x => x.startsWith("记忆"))).toBe(false);
    const base = settingsItems(fakeH([]));
    expect(base.some(x => x.startsWith("记忆"))).toBe(false);
    // hooks-ui.test 外部锚位（技能 5 → 钩子 6 → MCP 7）不受影响
    expect(base.findIndex(x => x.startsWith("技能"))).toBe(5);
    expect(base.findIndex(x => x.startsWith("钩子"))).toBe(6);
    expect(base.findIndex(x => x.startsWith("MCP"))).toBe(7);
  });
});
