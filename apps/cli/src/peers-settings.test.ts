import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { Harness } from "@orosus/core";
import { memoryImportResultText, mirrorImportResultText, readPeersConfig, runMemoryImportChoose, runMemorySetting, writePeersConfigKey, type MemoryImportDeps } from "./peers-settings.ts";
import * as theme from "./theme.ts";
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

  it("③c 导入选择段（走查八-④ 开关形态）：源行/全部/模式行/整理开关行；开关开后所有路径走整理；Esc/空货源", async () => {
    const deps: MemoryImportDeps = {
      detect: () => [
        { id: "claude-code", label: "Claude Code", count: 12 },
        { id: "zcode", label: "ZCode", count: 37 },
        { id: "qwen", label: "qwen-code", count: 0 },   // 无货不列
      ],
      run: async () => ({ imported: 0, skipped: 0, merged: 0 }),   // 选择段不触 run
    };
    // 单源导入（默认整理关、默认范围 = 仅当前项目——D11 settings 侧增量补给心智）
    const single = await runMemoryImportChoose(async (_t, items) => items[0]!, deps);
    expect(single).toEqual({ ids: ["claude-code"], organize: false, mode: "current" });
    // 全部导入（源行后第一行 items[2]——qwen 0 条被滤；其后模式行/整理行）
    const all = await runMemoryImportChoose(async (_t, items) => items[2]!, deps);
    expect(all).toEqual({ ids: ["claude-code", "zcode"], organize: false, mode: "current" });
    // 整理行（末项）：切换后再选源行 = organize true
    const seq = ["last", "first"];
    let i = 0;
    const orgSingle = await runMemoryImportChoose(async (_t, items) => items[seq[i++] === "last" ? items.length - 1 : 0]!, deps);
    expect(orgSingle).toEqual({ ids: ["claude-code"], organize: true, mode: "current" });
    // Esc = undefined；无货源 = "empty"（不弹菜单）
    expect(await runMemoryImportChoose(async () => "", deps)).toBeUndefined();
    const emptyDeps: MemoryImportDeps = { detect: () => [{ id: "x", label: "X", count: 0 }], run: async () => ({ imported: 0, skipped: 0, merged: 0 }) };
    expect(await runMemoryImportChoose(async () => {
      throw new Error("不该弹菜单");
    }, emptyDeps)).toBe("empty");
  });

  it("③e T6 新 N 文案（G4）：源行带（新 M）；全局源（codex）行尾缀 G2 标注", async () => {
    const deps: MemoryImportDeps = {
      detect: () => [
        { id: "claude-code", label: "Claude Code", count: 12, newCount: 3 },
        { id: "codex", label: "codex", count: 9, newCount: 9, global: true },
      ],
      run: async () => ({ imported: 0, skipped: 0, merged: 0 }),
    };
    let seen: string[] = [];
    const r = await runMemoryImportChoose(async (_t, items) => { seen = items; return items[0]!; }, deps);
    expect(r).toEqual({ ids: ["claude-code"], organize: false, mode: "current" });
    expect(seen[0]).toContain("导入该源 12 条（新 3）");
    expect(seen[1]).toContain("全局源——不分项目，含所有项目的笔记");
  });

  it("③f T6 已全部导入（D7）：M=0 行显示已全部导入且选拦（菜单重开不执行）；镜像模式不拦", async () => {
    const deps: MemoryImportDeps = {
      detect: () => [
        { id: "claude-code", label: "Claude Code", count: 12, newCount: 0 },
        { id: "zcode", label: "ZCode", count: 37, newCount: 5 },
      ],
      run: async () => ({ imported: 0, skipped: 0, merged: 0 }),
    };
    const picks: number[] = [0, 1];   // 先选拦行 → 菜单重开 → 再选可用行
    let i = 0;
    const r = await runMemoryImportChoose(async (_t, items) => items[picks[i++]!]!, deps);
    expect(r).toEqual({ ids: ["zcode"], organize: false, mode: "current" });   // 第一次选拦行没执行、没 Esc
    // 镜像模式（切模式行后）：M=0 行可选拦解除（判重按各目标桶独立算）
    const picks2: number[] = [3, 0];   // items: [cc, zcode, 全部, 模式, 整理] → 3 = 模式行（切 all），0 = cc 行
    let j = 0;
    const r2 = await runMemoryImportChoose(async (_t, items) => items[picks2[j++]!]!, deps);
    expect(r2).toEqual({ ids: ["claude-code"], organize: false, mode: "all" });
  });

  it("③g T6 模式行（G10/D11）：默认 current，回车切换 ✓ 移位到全部项目；结果带 mode（当次会话态）；着色=标签白+当前值连勾绿（2026-10-08 用户走查修）", async () => {
    const deps: MemoryImportDeps = {
      detect: () => [{ id: "claude-code", label: "Claude Code", count: 5, newCount: 2 }],
      run: async () => ({ imported: 0, skipped: 0, merged: 0 }),
    };
    const seen: string[][] = [];
    let call = 0;
    const r = await runMemoryImportChoose(async (_t, items) => {
      seen.push([...items]);
      call++;
      return items[call === 1 ? 2 : 0]!;   // 首轮选模式行（回车切换），次轮选源行执行
    }, deps);
    expect(seen[0]![2]).toContain("仅当前项目 ✓");          // 默认 current（D11：settings 增量补给心智）
    expect(seen[0]![2]).toContain(theme.fg("accent", "仅当前项目 ✓"));   // 当前值连勾 = accent 绿
    expect(seen[0]![2]).toContain(theme.fg("fg", "导入范围 —— "));       // 标签恒白
    expect(seen[0]![2]).not.toContain(theme.fg("accent", "全部项目（各归各桶）"));
    expect(seen[1]![2]).not.toContain("仅当前项目 ✓");
    expect(seen[1]![2]).toContain(theme.fg("accent", "全部项目（各归各桶）✓"));   // ✓ 移位且同绿
    expect(seen[1]![2]).toContain(theme.fg("fg", "仅当前项目"));   // 非当前选项回白
    expect(r).toEqual({ ids: ["claude-code"], organize: false, mode: "all" });
  });

  it("③h T6 全部导入行合计 = sum(newCount)（G4）", async () => {
    const deps: MemoryImportDeps = {
      detect: () => [
        { id: "claude-code", label: "Claude Code", count: 12, newCount: 3 },
        { id: "zcode", label: "ZCode", count: 37, newCount: 5 },
      ],
      run: async () => ({ imported: 0, skipped: 0, merged: 0 }),
    };
    let seen: string[] = [];
    await runMemoryImportChoose(async (_t, items) => { seen = items; return items[0]!; }, deps);
    expect(seen[2]).toContain("2 家共 8 条");   // 3 + 5（不再是 12 + 37）
  });

  it("③i T6 镜像结果文案（G12）：分段省略——双零裸句 / 单零省一段 / 全留", () => {
    expect(mirrorImportResultText({ imported: 6, skipped: 0, mirror: { projects: 2, unresolved: 0 } }))
      .toBe("已导入 2 个项目共 6 条");
    expect(mirrorImportResultText({ imported: 6, skipped: 4, mirror: { projects: 2, unresolved: 0 } }))
      .toBe("已导入 2 个项目共 6 条（跳过 4 条重复）");
    expect(mirrorImportResultText({ imported: 6, skipped: 0, mirror: { projects: 2, unresolved: 1 } }))
      .toBe("已导入 2 个项目共 6 条（1 个项目未能定位）");
    expect(mirrorImportResultText({ imported: 6, skipped: 4, mirror: { projects: 2, unresolved: 1 } }))
      .toBe("已导入 2 个项目共 6 条（跳过 4 条重复 · 1 个项目未能定位）");
  });

  it("③d 导入结果人话：机械档不报整理；整理档报「模型整理 N 条」；全重复专句", () => {
    expect(memoryImportResultText({ imported: 10, skipped: 2, merged: 0 })).toContain("已导入 10 条记忆");
    expect(memoryImportResultText({ imported: 10, skipped: 2, merged: 0 })).not.toContain("模型整理");
    expect(memoryImportResultText({ imported: 31, skipped: 3, merged: 18 })).toContain("模型整理 18 条");
    expect(memoryImportResultText({ imported: 0, skipped: 5, merged: 0 })).toContain("全部与现有记忆重复");
  });

  it("④ settingsItems 动态插入：tool-peers active 才含「记忆」；discovered/缺席不含；序位 = MCP → 记忆 → 切换语言 → 更新检查 → 视觉 → 搜索（2026-10-08 用户拍板连座）", () => {
    const fakeH = (entries: { name: string; state: string }[]) =>
      ({ graph: () => ({ audit: () => entries }) }) as unknown as Harness;
    const withPeers = settingsItems(fakeH([{ name: "tool-peers", state: "active" }]));
    expect(withPeers).toHaveLength(13);
    expect(withPeers[7]).toContain("MCP");
    expect(withPeers[8]).toContain("记忆"); // 拍板①：记忆 = MCP 下面一行
    expect(withPeers[9]).toContain("切换语言"); // 拍板②：切换语言 = 记忆下面
    expect(withPeers[10]).toContain("更新检查"); // 拍板③：更新检测 = 切换语言下面
    expect(withPeers[11]).toContain("视觉");
    expect(withPeers[12]).toContain("网络搜索");
    const noPeers = settingsItems(fakeH([{ name: "tool-peers", state: "discovered" }]));
    expect(noPeers.some(x => x.startsWith("记忆"))).toBe(false);
    expect(noPeers[8]).toContain("切换语言"); // 记忆缺席——后续项上移一位
    const base = settingsItems(fakeH([]));
    expect(base.some(x => x.startsWith("记忆"))).toBe(false);
    // hooks-ui.test 外部锚位（技能 5 → 钩子 6 → MCP 7）不受影响
    expect(base.findIndex(x => x.startsWith("技能"))).toBe(5);
    expect(base.findIndex(x => x.startsWith("钩子"))).toBe(6);
    expect(base.findIndex(x => x.startsWith("MCP"))).toBe(7);
  });
});
