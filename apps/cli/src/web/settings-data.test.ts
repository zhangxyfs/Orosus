/** web 批 T12 伴生测试：设置·数据面 API——brief ①-⑦ 逐条（全真栈 runWebSubcommand + handover 托管，
 *  mcp-api.test 同款）：
 *  - ① GET /api/settings/general：disk 五目录结构化（cache/sessions/logs/tmp/modules 同源 diskUsageText）
 *    + total 行（F1 磁盘条总计）；tokens/ctx/runtime 键形在场；
 *  - ② tokens 本会话/项目累计（h.usage 同源——种子 assistant/message.usage 双口径入账）；
 *  - ③ GET/POST /api/settings/update：开关写 [update] check（F9）；
 *  - ④ GET /api/update 有新版时 {current,latest,hasUpdate:true}（fetchImpl 注入假 registry——零真网络）
 *    + GET /api/bootstrap 的 update? 接线（updateInfoNow 缓存直读——A4 胶囊可见性数据源）；
 *  - ⑤ locale：GET 三语列表 + POST 写 config 顶层 language 键 + 新 harness 生效（F8 边界：会话侧生效）；
 *  - ⑥ prefs 五键逐键落盘断言（visionModel 三态 / search.backend 四态校验 / [tool-subagent]
 *    model|approvalMode|maxTurns——maxTurns 数字裸、null 删键=跟随）+ reload 收口；
 *  - ⑦ 更新内容链路：readme 切片纯函数两形（含/不含 ### v<latest> 小节）+ GET /api/update 集成
 *    （成功 → notes+skipped 齐；取数失败 → notes 缺省、其余字段完整——降级走启动检查缓存）+
 *    release 门禁（fabricate 无段 README → 人话报错；有段含本版条目 → 通过；真仓 README 自证）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore } from "@orosus/core";
import { OROSUS_VERSION } from "@orosus/contracts/version";
import { runWebSubcommand, webHostPool } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { setUpdateFetchForTest, resetUpdateCacheForTest, sliceChangelogNotes } from "./api-settings.ts";
import { fireStartupUpdateCheck, resetUpdateCheckForTest, updateInfoNow } from "../update-check.ts";
import { readmeChangelogGate } from "../../../../scripts/release.mts";

/** 假 registry 的「更新版」——任何当前版都比它旧（isNewerVersion 恒真，不钉 OROSUS_VERSION 字面）。 */
const NEWER = "99.0.0";

/** 轮询等待（25ms 步进；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 引导门放行形态 config.toml（mcp-api.test 同款——本文件不发 prompt，死端口即可）。 */
const writeProviderConfig = (home: string): void => {
  writeFileSync(
    join(home, "config.toml"),
    `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\ntype = "openai"\n`,
    "utf8",
  );
};

/** 种子会话（真盘 jsonl——resume 托管面）；withUsage 附加 assistant/message.usage（② h.usage 双口径）。 */
const seedSession = async (home: string, cwd: string, sid: string, usage?: { input: number; output: number }): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  await store.append("session/label", { label: "设置数据面" });
  if (usage !== undefined) {
    await store.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage, durationMs: 12 });
  }
  await store.close();
};

interface Stack {
  base: string;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（mcp-api.test 同款）。 */
const startWebAt = async (home: string, cwd: string, sid: string): Promise<Stack> => {
  const lines: string[] = [];
  const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
  await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
  const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${inst.port}`,
    auth: { "x-orosus-token": inst.token, connection: "close" },
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

const getJson = async (s: Stack, path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${s.base}${path}`, { headers: s.auth });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const post = (s: Stack, path: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** 假 registry 全量 doc（/api/update 数据源——fetchImpl 注入，零真网络）。 */
const FAKE_README = [
  "# Orosus",
  "",
  "## 更新日志",
  "",
  `### v${NEWER}`,
  "",
  "- 新增 X。",
  "- 修复 Y。",
  "",
  "### v0.1.1",
  "",
  "- 旧条目。",
  "",
  "## License",
  "",
  "MIT",
  "",
].join("\n");
const fakeDocFetch = async (): Promise<{ ok: boolean; json: () => Promise<unknown> }> => ({
  ok: true,
  json: async () => ({
    "dist-tags": { latest: NEWER },
    versions: { "0.1.0": {}, "0.1.1": {}, "98.0.0": {}, [NEWER]: {} },
    readme: FAKE_README,
  }),
});
/** 假 /latest 端点（fireStartupUpdateCheck 的 fetchImpl——update-check.ts 既有取数面）。 */
const fakeLatestFetch = (async (): Promise<{ ok: boolean; json: () => Promise<unknown> }> => ({
  ok: true,
  json: async () => ({ version: NEWER, dist: { tarball: "https://example.invalid/orosus.tgz", integrity: "sha512-x" } }),
})) as unknown as typeof fetch;

describe("web T12：设置·数据面 API", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  let prevHome: string | undefined;
  let prevCwd: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t12-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t12-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    prevHome = process.env["OROSUS_HOME"];
    prevCwd = process.cwd();
  });

  afterEach(() => {
    shutdownWebServer("test-cleanup"); // 幂等——失败用例兜底清退
    resetUpdateCheckForTest(); // update-check 模块态复位（④/⑦ fireStartupUpdateCheck 点火痕迹）
    setUpdateFetchForTest(undefined);
    resetUpdateCacheForTest();
    if (prevHome === undefined) delete process.env["OROSUS_HOME"];
    else process.env["OROSUS_HOME"] = prevHome;
    if (prevCwd !== undefined && process.cwd() !== prevCwd) process.chdir(prevCwd); // chdir 兜底复位
    for (const c of cwds.splice(0)) {
      try { rmSync(c, { recursive: true, force: true }); } catch { /* 迟到句柄留给系统 tmp */ }
    }
    while (homes.length > 0) {
      const h = homes.pop()!;
      try { rmSync(h, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  });

  it("① GET /api/settings/general：disk 五目录结构化 + total 行；tokens/ctx/runtime 键形在场", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    mkdirSync(join(home, "cache"), { recursive: true });
    writeFileSync(join(home, "cache", "big.bin"), Buffer.alloc(1024 * 1024 + 512 * 1024, 7)); // 1.5 MiB
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "logs", "a.log"), "x", "utf8");
    mkdirSync(join(home, "tmp"), { recursive: true });
    writeFileSync(join(home, "tmp", "t1"), "x", "utf8");
    writeFileSync(join(home, "tmp", "t2"), "x", "utf8");
    await seedSession(home, cwd, "s_gen1");
    const s = await startWebAt(home, cwd, "s_gen1");

    const { status, body } = await getJson(s, "/api/settings/general");
    expect(status).toBe(200);
    expect(body["ok"]).toBe(true);
    const disk = body["disk"] as { name: string; mb: number; files: number }[];
    // 五目录（diskUsageText 同源名序）+ total 行（F1 磁盘条总计）
    expect(disk.map((d) => d.name)).toEqual(["cache", "sessions", "logs", "tmp", "modules", "total"]);
    const byName = new Map(disk.map((d) => [d.name, d]));
    expect(byName.get("cache")!.files).toBe(1);
    expect(byName.get("cache")!.mb).toBe(1.5);
    expect(byName.get("tmp")!.files).toBe(2);
    expect(byName.get("sessions")!.files).toBeGreaterThanOrEqual(1);
    const five = ["cache", "sessions", "logs", "tmp", "modules"].map((n) => byName.get(n)!);
    expect(byName.get("total")!.files).toBe(five.reduce((n, d) => n + d.files, 0));
    expect(byName.get("total")!.mb).toBeGreaterThanOrEqual(1.5);
    // 其余三卡键形在场（F1 图例/统计卡数据面——数值断言归 ②）
    expect(typeof (body["tokens"] as Record<string, unknown>)["input"]).toBe("number");
    const ctx = body["ctx"] as { used: number; window: number; pct: number };
    expect(ctx.window).toBeGreaterThan(0);
    expect(ctx.pct).toBeGreaterThanOrEqual(0);
    expect(ctx.pct).toBeLessThanOrEqual(100);
    expect(typeof (body["runtime"] as Record<string, unknown>)["elapsedMs"]).toBe("number");

    await s.stop();
  }, 60_000);

  it("② tokens 本会话/项目累计（h.usage 同源）+ ctx.used 末条 usage 投影", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_tok2", { input: 1200, output: 300 });
    const s = await startWebAt(home, cwd, "s_tok2");

    const { status, body } = await getJson(s, "/api/settings/general");
    expect(status).toBe(200);
    const tokens = body["tokens"] as { input: number; output: number; lifetimeInput: number; lifetimeOutput: number };
    expect(tokens.input).toBe(1200); // 本会话（sumUsage——assistant/message.usage 新形态）
    expect(tokens.output).toBe(300);
    expect(tokens.lifetimeInput).toBe(1200); // 项目累计（同桶单会话——lifetimeUsage 口径）
    expect(tokens.lifetimeOutput).toBe(300);
    const ctx = body["ctx"] as { used: number; window: number; pct: number };
    expect(ctx.used).toBe(1200); // 末条 usage 输入 = 最近上下文规模（lastUsageOf 同式）
    expect((body["runtime"] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);

    await s.stop();
  }, 60_000);

  it("③ GET/POST /api/settings/update：开关写 [update] check + 读回", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_upd3");
    const s = await startWebAt(home, cwd, "s_upd3");

    const g0 = await getJson(s, "/api/settings/update");
    expect(g0.status).toBe(200);
    expect(g0.body["enabled"]).toBe(true); // 缺省开（update-settings 同口径）
    expect(g0.body["current"]).toBe(OROSUS_VERSION);
    expect("latest" in g0.body).toBe(false); // 未查过（进程未点火）——latest 缺省

    const off = await post(s, "/api/settings/update", { enabled: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { ok: boolean }).ok).toBe(true);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml).toContain("[update]");
    expect(toml).toContain("check = false");
    const g1 = await getJson(s, "/api/settings/update");
    expect(g1.body["enabled"]).toBe(false);

    // 坏形拒收：enabled 非布尔 → 400 且不写盘
    const before = readFileSync(join(home, "config.toml"), "utf8");
    const bad = await post(s, "/api/settings/update", { enabled: "yes" });
    expect(bad.status).toBe(400);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(before);

    await s.stop();
  }, 60_000);

  it("④ GET /api/update 有新版 {current,latest,hasUpdate:true}（假 registry）+ bootstrap.update 接线", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_upd4");
    const s = await startWebAt(home, cwd, "s_upd4");

    // bootstrap 未查过 → update 字段缺省（T9 缺省形态沿用）
    const b0 = await getJson(s, "/api/bootstrap");
    expect("update" in b0.body).toBe(false);

    // 懒取（弹窗打开才查）：fetchImpl 注入假 registry，零真网络
    setUpdateFetchForTest(fakeDocFetch);
    resetUpdateCacheForTest();
    const u = await getJson(s, "/api/update");
    expect(u.status).toBe(200);
    expect(u.body["current"]).toBe(OROSUS_VERSION);
    expect(u.body["latest"]).toBe(NEWER);
    expect(u.body["hasUpdate"]).toBe(true);

    // bootstrap.update 接线：updateInfoNow() 缓存直读（启动检查点火——本测试进程模拟 main.ts 侧状态）
    fireStartupUpdateCheck({ enabled: true, lateNotify: () => {}, fetchImpl: fakeLatestFetch });
    await waitFor(() => updateInfoNow() !== undefined);
    const b1 = await getJson(s, "/api/bootstrap");
    expect(b1.body["update"]).toEqual({ current: OROSUS_VERSION, latest: NEWER });

    await s.stop();
  }, 60_000);

  it("⑤ locale：GET 三语列表；POST 写 config 顶层 language + 新 harness 生效；未知 tag → 400", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_loc5");
    const s = await startWebAt(home, cwd, "s_loc5");

    const g = await getJson(s, "/api/settings/locale");
    expect(g.status).toBe(200);
    expect(g.body["current"]).toBe(""); // 未配置（writeProviderConfig 无 language 键）——前端按「随系统」渲染
    const locales = g.body["locales"] as { tag: string; label: string; module?: true }[];
    const tags = locales.map((l) => l.tag);
    expect(tags).toContain("zh-CN");
    expect(tags).toContain("zh-TW");
    expect(tags).toContain("en-US");
    const zhCn = locales.find((l) => l.tag === "zh-CN")!;
    expect(zhCn.label).toBe("简体中文");

    const r = await post(s, "/api/settings/locale", { tag: "en-US" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('language = "en-US"');

    // 新 harness 生效（F8 边界：语言作用于会话侧——POST /api/sessions 建新会话即读新配置）
    const cr = await post(s, "/api/sessions", { cwd });
    expect(cr.status).toBe(200);
    const { sid } = (await cr.json()) as { sid: string };
    const h2 = webHostPool()?.host(sid)?.core;
    expect(h2?.configuredLanguage()).toBe("en-US");
    const g2 = await getJson(s, "/api/settings/locale");
    expect(g2.body["current"]).toBe("en-US");

    // 未知 tag → 400 且不写盘
    const before = readFileSync(join(home, "config.toml"), "utf8");
    const bad = await post(s, "/api/settings/locale", { tag: "fr-FR" });
    expect(bad.status).toBe(400);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(before);

    await s.stop();
  }, 60_000);

  it("⑥ prefs 五键逐键落盘（visionModel 三态 / search.backend / subagent 三键——maxTurns 数字、null 删键）+ reload 收口", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_pref6");
    const s = await startWebAt(home, cwd, "s_pref6");
    const media = join(home, "modules.d", "tool-media.toml");
    const web = join(home, "modules.d", "tool-web.toml");
    const sub = join(home, "modules.d", "tool-subagent.toml");
    const prefs = (body: Record<string, unknown>): Promise<Response> => post(s, "/api/settings/prefs", body);

    // visionModel 三态（off | auto | <模型id>——vision-media.ts:79 D12 三态）
    const v1 = await prefs({ key: "visionModel", value: "off" });
    expect(v1.status).toBe(200);
    const v1b = (await v1.json()) as { ok: boolean; report?: { failed: unknown[] } };
    expect(v1b.ok).toBe(true);
    expect(v1b.report?.failed).toEqual([]); // 写盘 → reload 收口（§4-12 直接 await）
    expect(readFileSync(media, "utf8")).toContain('visionModel = "off"');
    await prefs({ key: "visionModel", value: "auto" });
    expect(readFileSync(media, "utf8")).toContain('visionModel = "auto"');
    await prefs({ key: "visionModel", value: "zhipuai-coding-plan/glm-5.3" });
    expect(readFileSync(media, "utf8")).toContain('visionModel = "zhipuai-coding-plan/glm-5.3"');

    // search.backend 四态（auto|llm|tavily|brave——tool-web config schema）
    await prefs({ key: "search.backend", value: "tavily" });
    const webToml = readFileSync(web, "utf8");
    expect(webToml).toContain("[tool-web.search]");
    expect(webToml).toContain('backend = "tavily"');
    const sb = await prefs({ key: "search.backend", value: "bogus" });
    expect(sb.status).toBe(400); // 四态外拒收

    // [tool-subagent] model：写键 → 删键（null = 跟随）
    await prefs({ key: "model", value: "demo/model-x" });
    expect(readFileSync(sub, "utf8")).toContain('model = "demo/model-x"');
    await prefs({ key: "model", value: null });
    expect(readFileSync(sub, "utf8")).not.toContain("demo/model-x");

    // approvalMode：auto → null 删键
    await prefs({ key: "approvalMode", value: "auto" });
    expect(readFileSync(sub, "utf8")).toContain('approvalMode = "auto"');
    await prefs({ key: "approvalMode", value: null });
    expect(readFileSync(sub, "utf8")).not.toContain("approvalMode");

    // maxTurns：数字裸（不带引号）→ null 删键；域外 400
    await prefs({ key: "maxTurns", value: 150 });
    const subToml = readFileSync(sub, "utf8");
    expect(subToml).toContain("maxTurns = 150");
    expect(subToml).not.toContain('maxTurns = "150"');
    await prefs({ key: "maxTurns", value: null });
    expect(readFileSync(sub, "utf8")).not.toContain("maxTurns");
    const mt = await prefs({ key: "maxTurns", value: 500 });
    expect(mt.status).toBe(400); // 1-200 / -1 域外

    // 未知 key → 400
    expect((await prefs({ key: "bogus", value: "x" })).status).toBe(400);

    await s.stop();
  }, 60_000);

  it("⑦ 更新内容链路：readme 切片两形 + /api/update 集成（notes+skipped 齐 / 失败降级）+ release 门禁", async () => {
    // —— 纯函数：readme 切片（含 / 不含 ### v<latest> 小节）——
    const sliced = sliceChangelogNotes(FAKE_README, NEWER);
    expect(sliced).toBe(`### v${NEWER}\n\n- 新增 X。\n- 修复 Y。`); // 含小节头、尾空行剪净、止于下一 ###
    expect(sliceChangelogNotes(FAKE_README, "88.0.0")).toBeUndefined(); // 段在但无该版小节 → undefined 走降级
    expect(sliceChangelogNotes("# Orosus\n\n## License\n\nMIT\n", NEWER)).toBeUndefined(); // 无「## 更新日志」段
    expect(sliceChangelogNotes(undefined, NEWER)).toBeUndefined(); // registry doc 无 readme 字段

    // —— release 门禁（fabricate 无段 README → 人话中止；有段含本版条目 → 通过）——
    const noSection = readmeChangelogGate(NEWER, "# Orosus\n\n## License\n\nMIT\n");
    expect(typeof noSection).toBe("string");
    expect(noSection).toMatch(/更新日志/); // 人话：缺段
    const noEntry = readmeChangelogGate(NEWER, "## 更新日志\n\n### v0.1.1\n\n- 旧条目。\n");
    expect(typeof noEntry).toBe("string");
    expect(noEntry).toMatch(new RegExp(`### v${NEWER.replaceAll(".", "\\.")}`)); // 人话：缺本版条目
    expect(readmeChangelogGate(NEWER, `## 更新日志\n\n### v${NEWER}\n\n- x\n`)).toBeUndefined(); // 通过
    // 真仓 README 自证：段骨架 + 当前版首条在册（A4 供给侧）
    const realReadme = readFileSync(fileURLToPath(new URL("../../../../README.md", import.meta.url)), "utf8");
    expect(readmeChangelogGate(OROSUS_VERSION, realReadme)).toBeUndefined();

    // —— 集成：GET /api/update 成功形（有新版且 readme 含段 → notes+skipped 齐）——
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_upd7");
    const s = await startWebAt(home, cwd, "s_upd7");

    setUpdateFetchForTest(fakeDocFetch);
    resetUpdateCacheForTest();
    const ok = await getJson(s, "/api/update");
    expect(ok.status).toBe(200);
    expect(ok.body["current"]).toBe(OROSUS_VERSION);
    expect(ok.body["latest"]).toBe(NEWER);
    expect(ok.body["hasUpdate"]).toBe(true);
    expect(ok.body["notes"]).toBe(`### v${NEWER}\n\n- 新增 X。\n- 修复 Y。`); // readme 切片直供（marked 渲染原料）
    expect(ok.body["skipped"]).toEqual(["98.0.0"]); // versions 键序中 current 与 latest 之间

    // 1h 内存缓存：缓存窗内二次请求零再取（假 fetch 计数）
    let fetches = 0;
    setUpdateFetchForTest(async () => {
      fetches++;
      return fakeDocFetch();
    });
    const again = await getJson(s, "/api/update");
    expect(again.body["latest"]).toBe(NEWER);
    expect(fetches).toBe(0); // 命中缓存——不再打 registry

    // —— 集成：取数失败 → notes 缺省、其余字段完整（降级走启动检查缓存——stale-while-error 同 D2 口径）——
    resetUpdateCacheForTest();
    setUpdateFetchForTest(async (): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
      throw new Error("registry 不可达（测试注入）");
    });
    resetUpdateCheckForTest();
    fireStartupUpdateCheck({ enabled: true, lateNotify: () => {}, fetchImpl: fakeLatestFetch });
    await waitFor(() => updateInfoNow() !== undefined);
    const fail = await getJson(s, "/api/update");
    expect(fail.status).toBe(200);
    expect(fail.body["current"]).toBe(OROSUS_VERSION);
    expect(fail.body["latest"]).toBe(NEWER);
    expect(fail.body["hasUpdate"]).toBe(true);
    expect("notes" in fail.body).toBe(false); // notes 缺省——前端走降级形态（版本号 + 落后列表 + 指引）
    expect("skipped" in fail.body).toBe(false);

    await s.stop();
  }, 60_000);
});
