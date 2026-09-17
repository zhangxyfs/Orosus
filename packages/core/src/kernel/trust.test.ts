import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "../index.ts";
import { fakeModule } from "@orosus/testing";
import { loadTrustStore, saveTrustStore, checkTrust } from "./trust.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const md = (p: string) => mkdirSync(p, { recursive: true });
const mk = () => { const d = mkdtempSync(join(tmpdir(), "orosus-trust-")); dirs.push(d); return d; };

describe("项目级信任门（§8.5，内容 hash + fail-closed）", () => {
  it("① 用户级模块恒过（亲手放置即隐式确认）", () => {
    const store = loadTrustStore(join(mk(), "absent.json"));
    expect(checkTrust({ layer: "user", root: "C:\\x\\m", entryHash: "h", store })).toEqual({ ok: true });
  });

  it("② 项目级未登记 → unconfirmed", () => {
    const store = loadTrustStore(join(mk(), "absent.json"));
    expect(checkTrust({ layer: "project", root: "C:\\x\\m", entryHash: "h", store })).toEqual({ ok: false, reason: "unconfirmed" });
  });

  it("③ 登记后 hash 一致 → 过", () => {
    const dir = mk();
    const file = join(dir, "trust.json");
    const store = loadTrustStore(file);
    store.entries["C:\\x\\m"] = { hash: "h1", confirmedAt: "2026-09-16" };
    saveTrustStore(file, store);
    expect(checkTrust({ layer: "project", root: "C:\\x\\m", entryHash: "h1", store: loadTrustStore(file) })).toEqual({ ok: true });
  });

  it("④ hash 变化 → hash-changed（MCPoison 教训：信任绑定内容而非名字/路径）", () => {
    const dir4 = mk();
    const store = loadTrustStore(join(dir4, "t.json"));
    store.entries["c:\\x\\m"] = { hash: "h1", confirmedAt: "t" }; // 归一化键（win32 小写）
    expect(checkTrust({ layer: "project", root: "C:\\x\\m", entryHash: "h2", store })).toEqual({ ok: false, reason: "hash-changed" });
  });

  it("⑤ trust.json roundtrip（含 Windows 盘符大小写归一化：D:\\ 与 d:\\ 命中同一条目）", () => {
    const dir = mk();
    const file = join(dir, "trust.json");
    const store = loadTrustStore(file);
    store.entries["D:\\develop\\mods\\m"] = { hash: "h", confirmedAt: "t" };
    saveTrustStore(file, store);
    const reloaded = loadTrustStore(file);
    expect(reloaded.entries["d:\\develop\\mods\\m"]?.hash).toBe("h"); // 读入侧已归一（win32 小写）
    expect(checkTrust({ layer: "project", root: "d:\\DEVELOP\\mods\\m", entryHash: "h", store: reloaded })).toEqual({ ok: true }); // 大小写归一
    // 解析失败视为空 store（全部重新确认，fail-closed 方向）
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(Object.keys(loadTrustStore(bad).entries)).toHaveLength(0);
  });

  it("⑥ harness 集成：项目级未确认模块 audit 为 failed(untrusted)，其余照常激活不阻断", async () => {
    const dir = mk();
    md(join(dir, "mods", "evil-mod"));
    writeFileSync(join(dir, "mods", "evil-mod", "index.ts"), `import { defineModule } from "@orosus/contracts/module";
export default defineModule({ name: "evil-mod", version: "0.1.0", description: "d", api: 1, activate() {} });
`);
    const good = fakeModule("good-mod", {});
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      builtinModules: [good],
      // 直接走 discover 注入太绕——用 harnessOptions 新口（本任务实现）：discovery 注入
      discovery: { userDir: join(dir, "no-user"), projectDir: join(dir, "mods"), trustFile: join(dir, "trust.json") },
      config: { userFile: join(dir, "no-user.toml"), projectFile: join(dir, "no-proj.toml"), env: {} },
    });
    const audit = h.graph().audit();
    const evil = audit.find((a) => a.name === "evil-mod");
    expect(evil?.state).toBe("failed");
    expect(evil?.failReason).toContain("untrusted");
    expect(audit.find((a) => a.name === "good-mod")?.state).toBe("active");
    await h.close();
  });
});
