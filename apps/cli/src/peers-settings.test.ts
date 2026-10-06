import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { Harness } from "@orosus/core";
import { readPeersConfig, runMemoryImportSetting, runMemorySetting, writePeersConfigKey, type MemoryImportDeps } from "./peers-settings.ts";
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

  it("③c 导入流：逐项/全部/模型整理三档 + 人话结果；无货源空态；Esc 空串（走查修订三+七-①）", async () => {
    const runs: Array<[string[], boolean]> = [];
    const deps: MemoryImportDeps = {
      detect: () => [
        { id: "claude-code", label: "Claude Code", count: 12 },
        { id: "zcode", label: "ZCode", count: 37 },
        { id: "qwen", label: "qwen-code", count: 0 },   // 无货不列
      ],
      run: async (ids, organize) => { runs.push([ids, organize]); return { imported: ids.length * 10, skipped: 2, merged: organize ? 5 : 0 }; },
    };
    // 单源导入（第一项，纯机械）
    const single = await runMemoryImportSetting(async (_t, items) => items[0]!, deps);
    expect(runs[0]).toEqual([["claude-code"], false]);
    expect(single).toContain("已导入 10 条记忆");
    expect(single).toContain("跳过 2 条重复");
    expect(single).toContain("/tool-peers__memory");
    expect(single).not.toContain("模型整理");   // 机械档不报整理
    // 全部导入（倒数第二项——只有两源列进：qwen 0 条被滤）
    const all = await runMemoryImportSetting(async (_t, items) => items[items.length - 2]!, deps);
    expect(all).toContain("已导入 20 条记忆");
    // 全部 + 模型整理（末项——organize 透传，结果报合并数）
    const org = await runMemoryImportSetting(async (_t, items) => items[items.length - 1]!, deps);
    expect(runs[runs.length - 1]).toEqual([["claude-code", "zcode"], true]);
    expect(org).toContain("模型整理合并 5 条");
    // Esc = 空串
    expect(await runMemoryImportSetting(async () => "", deps)).toBe("");
    // 全重复
    const dupDeps: MemoryImportDeps = { detect: deps.detect, run: async () => ({ imported: 0, skipped: 5, merged: 0 }) };
    expect(await runMemoryImportSetting(async (_t, items) => items[0]!, dupDeps)).toContain("全部与现有记忆重复");
    // 无货源空态（不弹菜单）
    const emptyDeps: MemoryImportDeps = { detect: () => [{ id: "x", label: "X", count: 0 }], run: async () => ({ imported: 0, skipped: 0, merged: 0 }) };
    const empty = await runMemoryImportSetting(async () => {
      throw new Error("不该弹菜单");
    }, emptyDeps);
    expect(empty).toContain("没有检测到可导入的记忆");
  });

  it("④ settingsItems 动态追加：tool-peers active 才含「记忆」；discovered/缺席不含；既有十项序位不乱", () => {
    const fakeH = (entries: { name: string; state: string }[]) =>
      ({ graph: () => ({ audit: () => entries }) }) as unknown as Harness;
    const withPeers = settingsItems(fakeH([{ name: "tool-peers", state: "active" }]));
    expect(withPeers).toHaveLength(11);
    expect(withPeers[10]).toContain("记忆");
    expect(settingsItems(fakeH([{ name: "tool-peers", state: "discovered" }])).some(x => x.startsWith("记忆"))).toBe(false);
    const base = settingsItems(fakeH([]));
    expect(base.some(x => x.startsWith("记忆"))).toBe(false);
    // hooks-ui.test 外部锚位（技能 5 → 钩子 6 → MCP 7）不受影响
    expect(base.findIndex(x => x.startsWith("技能"))).toBe(5);
    expect(base.findIndex(x => x.startsWith("钩子"))).toBe(6);
    expect(base.findIndex(x => x.startsWith("MCP"))).toBe(7);
  });
});
