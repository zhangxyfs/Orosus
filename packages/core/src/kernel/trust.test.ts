import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, chmodSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "../index.ts";
import { fakeModule } from "@orosus/testing";
import { loadTrustStore, saveTrustStore, checkTrust, trustModule, normalizeTrustKey as normalizeTrustKeyExport } from "./trust.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const md = (p: string) => mkdirSync(p, { recursive: true });
const mk = () => { const d = mkdtempSync(join(tmpdir(), "orosus-trust-")); dirs.push(d); return d; };

describe("项目级信任门（§8.5，内容 hash + fail-closed）", () => {
  it("① 用户级三态（m5 T17 修订：从恒免到一次性确认不追 hash）：未登记 = 待确认、有登记 = 过、内容变了不重问", () => {
    const dir = mk();
    const file = join(dir, "trust.json");
    const empty = loadTrustStore(join(dir, "absent.json"));
    expect(checkTrust({ layer: "user", root: "C:/x/m", entryHash: "h", store: empty })).toEqual({ ok: false, reason: "unconfirmed" }); // 未登记 = 待确认（进弹窗确认流）
    trustModule(file, "C:/x/m", "h1"); // 登记一次
    const store = loadTrustStore(file);
    expect(checkTrust({ layer: "user", root: "C:/x/m", entryHash: "h1", store })).toEqual({ ok: true });
    expect(checkTrust({ layer: "user", root: "C:/x/m", entryHash: "改了内容", store })).toEqual({ ok: true }); // 不追 hash——自己地盘改动不烦
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
    // CK-17：真实绝对路径替代原字面量 c:\x\m——POSIX 上它非绝对路径（resolve 成 cwd 相对），键永不命中、断言必败
    const root = join(dir4, "m");
    const store = loadTrustStore(join(dir4, "t.json"));
    store.entries[normalizeTrustKeyExport(root)] = { hash: "h1", confirmedAt: "t" };
    expect(checkTrust({ layer: "project", root, entryHash: "h2", store })).toEqual({ ok: false, reason: "hash-changed" });
  });

  it.skipIf(process.platform !== "win32")("④b CK-17 平台钉（win32 专属）：小写登记键、原大小写路径查询命中——大小写归一仅 win32 生效（trust.ts normalizeTrustKey）", () => {
    const dir4 = mk();
    const store = loadTrustStore(join(dir4, "t.json"));
    store.entries["c:\\x\\m"] = { hash: "h1", confirmedAt: "t" }; // 归一化键（win32 小写）
    expect(checkTrust({ layer: "project", root: "C:\\x\\m", entryHash: "h2", store })).toEqual({ ok: false, reason: "hash-changed" });
  });

  it("⑤ trust.json roundtrip：登记 → 落盘 → 读回命中（读入侧键归一；POSIX 恒等、win32 小写）；坏文件留档（CK-07）", () => {
    const dir = mk();
    const file = join(dir, "trust.json");
    // CK-17：临时目录真实路径替代原字面量 D:\develop\...（win32 专属形态拆去 ⑤b）——全平台成立
    const root = join(dir, "mods", "m");
    const store = loadTrustStore(file);
    store.entries[root] = { hash: "h", confirmedAt: "t" };
    saveTrustStore(file, store);
    const reloaded = loadTrustStore(file);
    expect(reloaded.entries[normalizeTrustKeyExport(root)]?.hash).toBe("h"); // 读入侧已归一——同一归一函数读回必命中
    expect(checkTrust({ layer: "project", root, entryHash: "h", store: reloaded })).toEqual({ ok: true });
    // 解析失败视为空 store（全部重新确认，fail-closed 方向）——坏文件被留档改名（CK-07⑦），原路径不复存在
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    const emptied = loadTrustStore(bad);
    expect(Object.keys(emptied.entries)).toHaveLength(0);
    expect(readdirSync(dir).some((f) => f.startsWith("bad.json.corrupt-"))).toBe(true); // CK-07：留档不无痕抹掉
  });

  it.skipIf(process.platform !== "win32")("⑤b CK-17 平台钉（win32 专属）：D:\\ 与 d:\\ 命中同一条目（盘符大小写归一——POSIX 无此归一，该断言必败）", () => {
    const dir = mk();
    const file = join(dir, "trust.json");
    const store = loadTrustStore(file);
    store.entries["D:\\develop\\mods\\m"] = { hash: "h", confirmedAt: "t" };
    saveTrustStore(file, store);
    const reloaded = loadTrustStore(file);
    expect(reloaded.entries["d:\\develop\\mods\\m"]?.hash).toBe("h"); // 读入侧已归一（win32 小写）
    expect(checkTrust({ layer: "project", root: "d:\\DEVELOP\\mods\\m", entryHash: "h", store: reloaded })).toEqual({ ok: true }); // 大小写归一
  });

  it("⑦ CK-07 回归钉·原子写：tmp+rename 后目录里只有目标文件（无 .tmp 残留）、覆写不截断；POSIX 下权限无条件 0600（含既有宽权限文件）", () => {
    const dir = mk();
    const file = join(dir, "trust.json");
    // 既有宽权限文件（模拟用户手建 644）——旧实现 0o600 只在新建分支生效，永不纠正
    writeFileSync(file, JSON.stringify({ entries: { a: { hash: "h1", confirmedAt: "t" } } }, null, 2));
    if (process.platform !== "win32") chmodSync(file, 0o666);
    saveTrustStore(file, { entries: { b: { hash: "h2", confirmedAt: "t2" } } }); // 覆写
    const names = readdirSync(dir);
    expect(names).toEqual(["trust.json"]); // tmp 文件随 rename 消失——无半截/残留
    const back = loadTrustStore(file);
    expect(back.entries[normalizeTrustKeyExport("b")]?.hash).toBe("h2"); // 覆写完整（读入侧键归一）
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600); // ③ 修复：覆写也钉 0600（旧实现手建 644 永宽）
    }
  });

  it("⑧ CK-07 回归钉·坏 JSON 不丢既有登记面：坏文件字节留档可查、后续登记照常落盘、留档不被覆盖", () => {
    const dir = mk();
    const file = join(dir, "trust.json");
    const badBytes = '{"entries": {"kept": {"hash": "h"'; // 手改半截——旧实现视为空后一次 save 就无痕抹掉
    writeFileSync(file, badBytes);
    expect(Object.keys(loadTrustStore(file).entries)).toHaveLength(0); // fail-closed：按空走
    const backupName = readdirSync(dir).find((f) => f.startsWith("trust.json.corrupt-"))!;
    expect(backupName).toBeDefined();
    expect(readFileSync(join(dir, backupName), "utf8")).toBe(badBytes); // 原样留档——登记可手工恢复
    trustModule(file, "C:\\x\\new", "h-new"); // 后续确认照常（新文件落盘）
    const after = loadTrustStore(file);
    expect(after.entries[normalizeTrustKeyExport("C:\\x\\new")]?.hash).toBe("h-new");
    expect(readdirSync(dir).some((f) => f === backupName)).toBe(true); // 留档仍在——未被新写覆盖
    // 连续登记（读-改-写全同步，进程内串行）：两条都在——丢登记面只存在于跨进程并发
    trustModule(file, "C:\\x\\second", "h-2");
    const final = loadTrustStore(file);
    expect(final.entries[normalizeTrustKeyExport("C:\\x\\new")]?.hash).toBe("h-new");
    expect(final.entries[normalizeTrustKeyExport("C:\\x\\second")]?.hash).toBe("h-2");
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
    expect(evil?.state).toBe("pending-confirm"); // m5 T17：待确认桶（不进 failed 计数——待决不是失败）
    expect(evil?.failReason).toContain("untrusted");
    expect(audit.find((a) => a.name === "good-mod")?.state).toBe("active");
    const pending = h.pendingConfirms();
    expect(pending.map((x) => `${x.name}:${x.layer}`)).toEqual(["evil-mod:project"]); // 载荷带 layer + root（弹窗显示来源用）
    expect(pending[0]!.root).toContain("evil-mod");
    expect(h.status().modules.failed).toBe(0); // 待确认不进 failed 计数
    await h.close();
  });
});
