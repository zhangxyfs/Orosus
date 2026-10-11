/** web 批 T8 伴生测试：模型/effort/权限/命令表 API——brief ①-⑤ 逐条（真栈 runWebSubcommand +
 *  handover 托管，T4/T6 同款）。①③⑤ 的目录数据面靠盘上目录夹具（<home>/cache/models-dev.json——
 *  diskFirstCatalogLoader 直读，零网络：listModels 目录优选返回策展清单、listThinking 出档位）；
 *  ① 的 beta 槽无目录条目 → live 兜底打死端口（ECONNREFUSED 即抛）→ 空清单降级不炸端点。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore, type SessionEvent } from "@orosus/core";
import { runWebSubcommand } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { t } from "../i18n/app.ts";

/** 轮询等待（25ms 步进；谓词可异步；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 盘上目录夹具（diskFirstCatalogLoader 直读——零网络）。demo 槽三模型（usableCatalogModels 无
 *  release_date → id 升序）：model-x 档位 [low,high,max]（无 off 声明 → 菜单档位不带 off 前缀）、
 *  model-y values 含 "none"（offEffort 在场 → 菜单档位带 off 前缀——kimi segments 推导钉）、
 *  model-n 无 reasoning_options（efforts 键缺省）。 */
const writeCatalogCache = (home: string): void => {
  mkdirSync(join(home, "cache"), { recursive: true });
  writeFileSync(join(home, "cache", "models-dev.json"), JSON.stringify({
    fetchedAt: Date.now(),
    catalog: {
      demo: {
        name: "演示厂商",
        api: "https://api.demo.example/v1",
        models: {
          "model-n": { id: "model-n", name: "Model N" },
          "model-x": { id: "model-x", name: "Model X 演示", limit: { context: 128000 }, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
          "model-y": { id: "model-y", name: "Model Y", limit: { context: 64000 }, reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }] },
        },
      },
    },
  }), "utf8");
};

/** 引导门放行形 config.toml（T4 教训：type = "openai" 必填——provider-custom 槽 schema）。
 *  demo 槽 baseUrl 与目录条目同源（清单走目录优选，不触网）；beta 槽无目录条目 → live 兜底死端口
 *  （空清单降级面的夹具）。model 顶层键（旧键形——F5 起读侧 provider ?? model 双兼容）。 */
const writeModelConfig = (home: string): void => {
  writeFileSync(join(home, "config.toml"), [
    'model = "demo/model-x"',
    "",
    "[provider-custom.providers.demo]",
    'baseUrl = "https://api.demo.example/v1"',
    'type = "openai"',
    "",
    "[provider-custom.providers.beta]",
    'baseUrl = "http://127.0.0.1:9"',
    'type = "openai"',
    "",
  ].join("\n"), "utf8");
};

/** 种子会话（header-only——handover 托管基座）。 */
const seedSession = async (home: string, cwd: string, sid: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  await store.close();
};

interface Stack {
  base: string;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（T4/T6 同款）。 */
const startWeb = async (home: string, cwd: string, sid: string): Promise<Stack> => {
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

/** POST JSON（content-type 即 T1 写方法护栏合规形态）。 */
const post = (s: Stack, path: string, body: unknown): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** GET JSON。 */
const get = async (s: Stack, path: string): Promise<{ status: number; body: unknown }> => {
  const r = await fetch(`${s.base}${path}`, { headers: s.auth });
  return { status: r.status, body: await r.json() };
};

/** GET status 九键（T4 端点——本批断言的运行期读面）。 */
const statusOf = async (s: Stack, sid: string): Promise<Record<string, unknown>> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/status`, { headers: s.auth });
  return (await r.json()) as Record<string, unknown>;
};

/** GET events 最新一页。 */
const latestEvents = async (s: Stack, sid: string): Promise<SessionEvent[]> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/events`, { headers: s.auth });
  const b = (await r.json()) as { events: SessionEvent[] };
  return b.events;
};

// ---------- 响应形状（消费侧本地声明——圈地纪律） ----------

interface ModelRow { name: string; label: string; ctx: number; efforts?: string[]; cur: boolean }
interface ProviderRow { key: string; displayName: string; models: ModelRow[] }
interface ModelsBody { current: string; providers: ProviderRow[] }
interface CommandRow { name: string; desc: string; long: string; aliases?: string[]; module?: boolean }

const modelsOf = async (s: Stack, sid?: string): Promise<{ status: number; body: ModelsBody }> => {
  const q = sid === undefined ? "" : `?sid=${sid}`;
  const r = await fetch(`${s.base}/api/models${q}`, { headers: s.auth });
  return { status: r.status, body: (await r.json()) as ModelsBody };
};

describe("web T8：模型/effort/权限/命令表 API", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t8-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t8-cwd-"));
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

  it("① GET /api/models：providers[].models[].cur 勾标 + efforts 目录档位（D10：无 auto）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeCatalogCache(home);
    writeModelConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_model");
    const s = await startWeb(home, cwd, "s_model");

    const { status, body } = await modelsOf(s, "s_model");
    expect(status).toBe(200);
    expect(body.current).toBe("demo/model-x");
    const demo = body.providers.find((p) => p.key === "demo");
    expect(demo).toBeDefined();
    expect(demo!.displayName).toBe("demo"); // 槽名（真目录名是 T13 提供商面的交付——本端点只走三服务调）
    expect(demo!.models.map((m) => m.name)).toEqual(["model-n", "model-x", "model-y"]); // 目录序（无 release_date → id 升序）
    const x = demo!.models.find((m) => m.name === "model-x")!;
    expect(x.label).toBe("model-x"); // label 缺目录来源时与 name 同值（T16 菜单显示用 name）
    expect(x.ctx).toBe(0); // 0 = 未知（目录 ctx 是 T13 提供商面交付）
    expect(x.efforts).toEqual(["low", "high", "max"]); // 目录档位原文（无 off 声明不加前缀）
    expect(x.cur).toBe(true); // 当前模型勾标（config model = demo/model-x）
    const y = demo!.models.find((m) => m.name === "model-y")!;
    expect(y.efforts).toEqual(["off", "low", "high"]); // offEffort 在场 → off 前缀（kimi segments 同式）
    expect(y.cur).toBe(false);
    const n = demo!.models.find((m) => m.name === "model-n")!;
    expect("efforts" in n).toBe(false); // 目录无思考信息 → 键缺省
    expect(demo!.models.filter((m) => m.cur)).toHaveLength(1); // 单勾标
    // beta 槽：无目录条目 → live 兜底死端口 → 空清单降级（端点不炸——「未配置」菜单态的数据面）
    const beta = body.providers.find((p) => p.key === "beta");
    expect(beta?.models).toEqual([]);
    // D10 硬断言：菜单数据面无 auto 伪档
    expect(JSON.stringify(body)).not.toContain("auto");
    // 无 sid 形：池当前会话游标兜底（handover 已指 s_model）
    const cur = await modelsOf(s);
    expect(cur.status).toBe(200);
    expect(cur.body.current).toBe("demo/model-x");
    await s.stop();
  }, 60_000);

  it("② POST model → h.status().model 变化 + config 顶层 provider 键写盘（旧 model 行清除）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeCatalogCache(home);
    writeModelConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_switch");
    const s = await startWeb(home, cwd, "s_switch");

    const r = await post(s, "/api/sessions/s_switch/model", { platform: "demo", model: "model-y" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });

    await waitFor(async () => (await statusOf(s, "s_switch"))["model"] === "demo/model-y"); // h.status().model（运行期覆盖即时可见）
    const cfg = readFileSync(join(home, "config.toml"), "utf8");
    expect(cfg).toMatch(/^provider = "demo\/model-y"$/m); // F5 顶层 provider 键（h.setModel 内 upsertTopLevelKey 同键）
    expect(cfg).not.toMatch(/^model = /m); // 旧 model 行随过滤清除（applyModelOverride 同款）

    // cur 勾标迁移
    const { body } = await modelsOf(s, "s_switch");
    const demo = body.providers.find((p) => p.key === "demo")!;
    expect(demo.models.find((m) => m.name === "model-y")!.cur).toBe(true);
    expect(demo.models.find((m) => m.name === "model-x")!.cur).toBe(false);

    // 坏请求形：未知平台（槽不在图）/ 缺 model
    expect((await post(s, "/api/sessions/s_switch/model", { platform: "nope", model: "x" })).status).toBe(400);
    expect((await post(s, "/api/sessions/s_switch/model", { platform: "demo" })).status).toBe(400);

    // 盘上未托管会话（viewer 化只读）→ 409；不在盘 → 404
    const cwd2 = tmpCwd();
    await seedSession(home, cwd2, "s_other");
    expect((await post(s, "/api/sessions/s_other/model", { platform: "demo", model: "model-x" })).status).toBe(409);
    expect((await post(s, "/api/sessions/s_none/model", { platform: "demo", model: "model-x" })).status).toBe(404);
    await s.stop();
  }, 60_000);

  it("③ POST effort {level} → 写盘；未设置时 status.effort = 目录默认档名（D10：不显示 auto）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeCatalogCache(home);
    writeModelConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_eff");
    const s = await startWeb(home, cwd, "s_eff");

    // 未设置档：status.effort = 目录默认档（middleOf [low,high,max] = high——预热 memo；芯片显示档名非「自动」的数据面）
    await waitFor(async () => (await statusOf(s, "s_eff"))["effort"] === "high");

    const r = await post(s, "/api/sessions/s_eff/effort", { level: "low" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(readFileSync(join(home, "config.toml"), "utf8")).toMatch(/^effort = "low"$/m); // 顶层 effort 键（setEffort 写盘）
    await waitFor(async () => (await statusOf(s, "s_eff"))["effort"] === "low");

    // D10：web 无 auto 伪档口——拒收（core 的 auto = 清档回默认，web 不暴露清档入口）
    expect((await post(s, "/api/sessions/s_eff/effort", { level: "auto" })).status).toBe(400);
    // 格式闸（core 同规：仅小写字母数字与 . _ -）
    expect((await post(s, "/api/sessions/s_eff/effort", { level: "HIGH" })).status).toBe(400);
    expect((await post(s, "/api/sessions/s_eff/effort", { level: "" })).status).toBe(400);
    await s.stop();
  }, 60_000);

  it("④ POST permission never → 等价 /permission never（写盘 + policy 事件 + 运行期即时可见）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeCatalogCache(home);
    writeModelConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_perm");
    const s = await startWeb(home, cwd, "s_perm");

    const r = await post(s, "/api/sessions/s_perm/permission", { mode: "never" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });

    await waitFor(async () => (await latestEvents(s, "s_perm")).some((e) => e.type === "approval/policy"));
    const ev = (await latestEvents(s, "s_perm")).toReversed().find((e) => e.type === "approval/policy") as { mode?: unknown };
    expect(ev.mode).toBe("never"); // 切换落日志（approval 模块——与 /permission never 同事件面）
    expect(readFileSync(join(home, "config.toml"), "utf8")).toMatch(/mode = "never"/); // 写生效层
    await waitFor(async () => (await statusOf(s, "s_perm"))["permission"] === "never"); // 运行期即时可见

    // 三档白名单外 → 400
    expect((await post(s, "/api/sessions/s_perm/permission", { mode: "yolo" })).status).toBe(400);
    await s.stop();
  }, 60_000);

  it("⑤ GET /api/commands：web 命令表 14 条 + 模块命令投影；技能与界面命令不可见", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeCatalogCache(home);
    writeModelConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_cmds");
    const s = await startWeb(home, cwd, "s_cmds");

    const { status, body } = await get(s, "/api/commands?sid=s_cmds");
    expect(status).toBe(200);
    const items = (body as { items: CommandRow[] }).items;
    const names = items.map((i) => i.name);
    // 14 条（原型 CMDS 序逐字——G1：不含 /settings /sessions /provider /permission）
    expect(names.slice(0, 14)).toEqual(["/yolo", "/auto", "/help", "/model", "/effort", "/compact", "/tasks", "/btw", "/ps", "/quit", "/new", "/fork", "/title", "/reload"]);
    // 分家口径：界面命令 / 放行不列项 / 技能不在命令面（/provider /permission 键入经 core 别名仍可达——仅菜单不列）
    for (const n of ["/settings", "/sessions", "/provider", "/permission", "/context", "/web", "/skill"]) {
      expect(names).not.toContain(n);
    }
    expect(names.some((n) => n.toLowerCase().includes("skill"))).toBe(false); // 技能走 /api/settings/skills（T13——D13 前端合流）
    // desc/long 与 slashItems 同族 t() 键同源（G1：main.ts 模块私有不可 import——web 表复用同键）
    const model = items.find((i) => i.name === "/model")!;
    expect(model.desc).toBe(t("slash.items.model.desc"));
    expect(model.long).toBe(t("slash.items.model.long"));
    const yolo = items.find((i) => i.name === "/yolo")!;
    expect(yolo.desc).toBe(t("slash.items.yolo.desc"));
    // 14 条 desc/long 全非空
    for (const row of items.slice(0, 14)) {
      expect(row.desc).toBeTruthy();
      expect(row.long).toBeTruthy();
    }
    // 别名（原型展开 18 名的三组：/exit /q、/task、/rename）
    expect(items.find((i) => i.name === "/quit")!.aliases).toEqual(["exit", "q"]);
    expect(items.find((i) => i.name === "/tasks")!.aliases).toEqual(["task"]);
    expect(items.find((i) => i.name === "/title")!.aliases).toEqual(["rename"]);
    // 模块命令投影（graph().commands——builtin 模块图：approval/session-tree 在场，module:true 标记）
    const mod = items.find((i) => i.name === "/approval__permission");
    expect(mod).toBeDefined();
    expect(mod!.module).toBe(true);
    expect(items.some((i) => i.name === "/session-tree__view" && i.module === true)).toBe(true);
    // 无 sid 形：池当前会话图兜底（不 404）
    const cur = await get(s, "/api/commands");
    expect(cur.status).toBe(200);
    expect((cur.body as { items: CommandRow[] }).items.length).toBeGreaterThan(14);
    await s.stop();
  }, 60_000);
});
