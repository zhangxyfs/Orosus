/** web 批 T14 伴生测试：更多菜单四端点（A7 ⋮ 菜单数据面——TUI Ctrl+E/P/H/O 的 web 化）——brief ①-④ 逐条。
 *  - ① GET /api/diagnostics：rows = graph().audit() failed 行（fabricate 已信任但 version 非 semver 的
 *    用户层模块 → 静态校验降级 failed）+ logDir = <home>/logs；显式坏 sid → 404；
 *  - ② GET /api/launchers：cards = active 模块 launcher 登记投影 {module,title,desc}（title 经
 *    t(labelKey) 翻译——launcherRows 同源；tool-peers 内置登记为确定性锚点）；显式坏 sid → 404；
 *  - ③ GET /api/sessions/:sid/hooks-activity：fabricate hooks/run + agent/steering-message 事件分桶
 *    归属正确（首条消息前的 SessionStart 并入首桶——hooks-ui.ts:111 同源语义）；无钩子会话 → []；
 *    未托管会话走 viewer 只读化身同出数；未知 sid → 404；
 *  - ④ GET /api/sessions/:sid/compaction：末条 turn/compaction 的 summary/stats（at = 事件 ts；
 *    keptUsers 不内联——重载荷不进摘要面）；无压缩事件 → 404；未知 sid → 404。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore, trustModule } from "@orosus/core";
import { runWebSubcommand } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { t } from "../i18n/app.ts";

/** 轮询等待（25ms 步进；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ---------- 真栈工具（T4/T5/T7/T10 同款） ----------

/** 引导门放行形态 config.toml（type = "openai"——provider-custom 槽 schema 必填协议族）。 */
const writeProviderConfig = (home: string, baseUrl: string): void => {
  writeFileSync(
    join(home, "config.toml"),
    `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "${baseUrl}"\ntype = "openai"\n`,
    "utf8",
  );
};

/** 种子事件对（type, fields）。 */
type SeedEvent = [type: string, fields: Record<string, unknown>];

/** turn/compaction v4 载荷（session/types.ts:44——keptUsers 完整投影内联、elidedCount/droppedCount）。 */
const compactionEvent = (summary: string, trigger: string, droppedCount: number, elidedCount: number, keep: string): SeedEvent => [
  "turn/compaction",
  { trigger, summary, keepUserHead: 1, keptUsers: [{ role: "user", content: [{ kind: "text", text: keep }] }], elidedCount, droppedCount },
];

/** 种子会话（真盘 jsonl——resume 后 history()/审计面即端点输入，fabricate 事件即数据）。 */
const seedSession = async (home: string, cwd: string, sid: string, events: SeedEvent[]): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  for (const [type, fields] of events) await store.append(type, fields);
  await store.close();
};

/** 已信任但静态校验必败的用户层模块（<home>/modules/<名>/index.js——jiti 可载、trust.json 认登记
 *  （用户层不看 hash），version 非 semver → kernel validateModule 降级 failed——audit failed 行实触发面）。 */
const fabricateFailedModule = (home: string, name: string): void => {
  const dir = join(home, "modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), `export default { name: ${JSON.stringify(name)}, version: "0.1", description: "演示失败模块", api: 1, activate() {} };\n`, "utf8");
  trustModule(join(home, "trust.json"), dir, "unused"); // 用户层：认登记即信（不追 hash）
};

interface Stack {
  base: string;
  port: number;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（T4/T5/T7 同款）。 */
const startWeb = async (home: string, cwd: string, sid: string): Promise<Stack> => {
  const lines: string[] = [];
  const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
  await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
  const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${inst.port}`,
    port: inst.port,
    auth: { "x-orosus-token": inst.token, connection: "close" },
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

/** GET JSON（断言期望 status 后解析体）。 */
const getJson = async <T>(s: Stack, path: string, status = 200): Promise<T> => {
  const r = await fetch(`${s.base}${path}`, { headers: s.auth });
  expect(r.status).toBe(status);
  return (await r.json()) as T;
};

// ---------- 响应体形状（§3 :237/:238/:271/:272） ----------

interface DiagBody { ok: boolean; rows: Array<{ name: string; failReason: string; state: string }>; logDir: string }
interface LauncherCard { module: string; title: string; desc?: string }
interface LauncherBody { ok: boolean; cards: LauncherCard[] }
interface HooksGroup { userText: string; count: number; injections: string[] }
interface HooksBody { ok: boolean; groups: HooksGroup[] }
interface CompactionBody { ok: boolean; at: string; summary: string; stats: Record<string, unknown> }

describe("web T14：更多菜单 API（诊断/总览/钩子注入/压缩摘要）", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t14-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t14-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    prevHome = process.env["OROSUS_HOME"];
  });

  afterEach(() => {
    shutdownWebServer("test-cleanup"); // 幂等——失败用例兜底清退
    if (prevHome === undefined) delete process.env["OROSUS_HOME"];
    else process.env["OROSUS_HOME"] = prevHome;
    for (const c of cwds.splice(0)) {
      try { rmSync(c, { recursive: true, force: true }); } catch { /* 迟到句柄留给系统 tmp */ }
    }
    while (homes.length > 0) {
      const h = homes.pop()!;
      try { rmSync(h, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  });

  it("① GET /api/diagnostics：audit failed 行（fabricate 非 semver 降级模块）+ logDir；显式坏 sid → 404", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeProviderConfig(home, "http://127.0.0.1:9"); // 死端口——本用例不发 prompt
    fabricateFailedModule(home, "diag-bad");
    await seedSession(home, cwd, "s_diag1", [["user/message", { content: [{ kind: "text", text: "跑一下" }] }]]);
    const s = await startWeb(home, cwd, "s_diag1");

    const b = await getJson<DiagBody>(s, "/api/diagnostics");
    expect(b.ok).toBe(true);
    // rows 只收 failed 行（active/discovered/pending-confirm 不进——「出过问题的模块」口径）
    for (const r of b.rows) expect(r.state).toBe("failed");
    const bad = b.rows.find((r) => r.name === "diag-bad");
    expect(bad).toBeDefined();
    expect(bad!.state).toBe("failed");
    expect(bad!.failReason).toContain("非 semver"); // validate.ts:21 原文
    expect(b.rows.some((r) => r.name === "approval")).toBe(false); // active 模块不进诊断行
    // logDir = 诊断日志目录（TUI Ctrl+E 详情尾行同源——readDiagnostics 目录）
    expect(b.logDir).toBe(join(home, "logs"));
    // 显式坏 sid → 404（api-model resolveForRead 同口径）
    const nf = await fetch(`${s.base}/api/diagnostics?sid=s_none`, { headers: s.auth });
    expect(nf.status).toBe(404);

    await s.stop();
  }, 60_000);

  it("② GET /api/launchers：active 模块 launcher 登记投影 {module,title,desc}（tool-peers 确定性锚点 + labelKey 翻译）；显式坏 sid → 404", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeProviderConfig(home, "http://127.0.0.1:9");
    await seedSession(home, cwd, "s_lau2", [["user/message", { content: [{ kind: "text", text: "跑一下" }] }]]);
    const s = await startWeb(home, cwd, "s_lau2");

    const b = await getJson<LauncherBody>(s, "/api/launchers");
    expect(b.ok).toBe(true);
    expect(b.cards.length).toBeGreaterThan(0);
    for (const c of b.cards) {
      expect(typeof c.module).toBe("string");
      expect(typeof c.title).toBe("string");
    }
    // tool-peers 默认挂载 + launcher 登记（module-launcher.ts 唯一内置登记面）——title 经 labelKey 翻译
    const peers = b.cards.find((c) => c.module === "tool-peers");
    expect(peers).toEqual({ module: "tool-peers", title: t("peers.launcher.label", undefined, "记忆"), desc: "/tool-peers__memory" });
    const nf = await fetch(`${s.base}/api/launchers?sid=s_none`, { headers: s.auth });
    expect(nf.status).toBe(404);

    await s.stop();
  }, 60_000);

  it("③ GET /api/sessions/:sid/hooks-activity：hooks/run 分桶归属最近 user/message（首条前并入首桶）；无钩子 → []；未托管 viewer 同出数；未知 sid → 404", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeProviderConfig(home, "http://127.0.0.1:9");
    const injection = "钩子注入（SessionStart · 载入约定）\n# 项目约定\n- 模块签名按 IModule 规范";
    await seedSession(home, cwd, "s_hook3", [
      // 首条 user/message 之前（SessionStart）——暂存并入首桶（hooks-ui.ts:111 同源：无「会话启动」伪桶）
      ["hooks/run", { event: "SessionStart", hook: "node greet.js", name: "载入约定", product: "demo-hook", status: "pass", runId: 1, durationMs: 30 }],
      ["user/message", { content: [{ kind: "text", text: "帮我为 harness 增加一个会话压缩模块\n要考虑阈值" }] }],
      ["agent/steering-message", { messages: [{ text: injection, sourceModule: "host/hook" }] }],
      ["hooks/run", { event: "UserPromptSubmit", hook: "check.sh", status: "error", runId: 7, durationMs: 12, reason: "exit 1" }],
      ["user/message", { content: [{ kind: "text", text: "再把压缩阈值调到 80%" }] }],
      ["hooks/run", { event: "UserPromptSubmit", hook: "curl http://x", status: "deny", runId: 8 }],
    ]);
    // 第二会话：无钩子活动（空态）+ 单钩子一桶（viewer 路径——不交接，端点走盘上只读化身）
    await seedSession(home, cwd, "s_hook3b", [
      ["user/message", { content: [{ kind: "text", text: "未托管的会话" }] }],
      ["hooks/run", { event: "UserPromptSubmit", hook: "echo hi", status: "pass", runId: 9 }],
    ]);
    await seedSession(home, cwd, "s_hook3c", [["user/message", { content: [{ kind: "text", text: "没有任何钩子" }] }]]);
    const s = await startWeb(home, cwd, "s_hook3");

    const b = await getJson<HooksBody>(s, "/api/sessions/s_hook3/hooks-activity");
    expect(b.ok).toBe(true);
    // 分桶归属：首桶收 SessionStart（并入）+ 首条消息后的 UserPromptSubmit；次桶只收各自最近消息的运行
    expect(b.groups).toEqual([
      { userText: "帮我为 harness 增加一个会话压缩模块", count: 2, injections: [injection] },
      { userText: "再把压缩阈值调到 80%", count: 1, injections: [] },
    ]);
    // viewer（未托管盘上会话）同出数——只读化身合法消费口
    const vb = await getJson<HooksBody>(s, "/api/sessions/s_hook3b/hooks-activity");
    expect(vb.groups).toEqual([{ userText: "未托管的会话", count: 1, injections: [] }]);
    // 无钩子活动会话 → 空表（不是 404——「没有可看的」是空态）
    const eb = await getJson<HooksBody>(s, "/api/sessions/s_hook3c/hooks-activity");
    expect(eb.groups).toEqual([]);
    // 未知 sid → 404
    const nf = await fetch(`${s.base}/api/sessions/s_none/hooks-activity`, { headers: s.auth });
    expect(nf.status).toBe(404);

    await s.stop();
  }, 60_000);

  it("④ GET /api/sessions/:sid/compaction：末条 turn/compaction 的 at/summary/stats（keptUsers 不内联）；无压缩事件 → 404；未知 sid → 404", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeProviderConfig(home, "http://127.0.0.1:9");
    await seedSession(home, cwd, "s_comp4", [
      ["user/message", { content: [{ kind: "text", text: "第一轮" }] }],
      compactionEvent("旧摘要——第一轮要点", "auto", 10, 2, "第一轮"),
      ["user/message", { content: [{ kind: "text", text: "第二轮" }] }],
      compactionEvent("新摘要——交接要点：阈值 80%", "manual", 8, 1, "第二轮"),
    ]);
    await seedSession(home, cwd, "s_comp4b", [["user/message", { content: [{ kind: "text", text: "从未压缩" }] }]]);
    const s = await startWeb(home, cwd, "s_comp4");

    const b = await getJson<CompactionBody>(s, "/api/sessions/s_comp4/compaction");
    expect(b.ok).toBe(true);
    expect(b.summary).toBe("新摘要——交接要点：阈值 80%"); // 末条胜（Ctrl+O 开窗即见最近一次）
    expect(typeof b.at).toBe("string");
    expect(Number.isNaN(Date.parse(b.at))).toBe(false); // 事件 ts（ISO）
    // stats = 标量统计面（trigger/计数/保留头），keptUsers 完整投影消息不内联（重载荷不进摘要口）
    expect(b.stats).toEqual({ trigger: "manual", keepUserHead: 1, elidedCount: 1, droppedCount: 8 });
    expect("keptUsers" in b.stats).toBe(false);
    // 无压缩事件 → 404（§3 :238 | 404——「没有摘要可看」是缺资源不是空表）
    const nf1 = await fetch(`${s.base}/api/sessions/s_comp4b/compaction`, { headers: s.auth });
    expect(nf1.status).toBe(404);
    const nf2 = await fetch(`${s.base}/api/sessions/s_none/compaction`, { headers: s.auth });
    expect(nf2.status).toBe(404);

    await s.stop();
  }, 60_000);
});
