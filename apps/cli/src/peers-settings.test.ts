import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { Harness } from "@orosus/core";
import { readPeersConfig, runMemorySetting, writePeersConfigKey } from "./peers-settings.ts";
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

  it("③b 第三项「浏览记忆」→ { kind: browse }（不写盘）", async () => {
    const f = tmpCfg();
    const res = await runMemorySetting(async (_t, items) => items[2]!, f);
    expect(res).toEqual({ kind: "browse" });
    expect(readPeersConfig(f)).toEqual({ workspaceMemory: false, sessionPeers: false });
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
