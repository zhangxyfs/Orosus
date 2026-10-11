/** web 批 T11 伴生测试：MCP 面 API——brief ①-⑤ 逐条（全真栈 runWebSubcommand + handover 托管，T4/T5/T7/T10 同款）。
 *  - ① GET /api/settings/mcp：catalog 行五态映射（connected = tests/fixtures 假 server 真连 / failed =
 *    启动即败 / disabled = enabled=false / pending-confirm = 项目 .mcp.json 指纹门 / idle = 预装懒启动件）
 *    + GET /panel 的 network.connections 填充（T10 跨任务指针闭合——mcpConnRows 同投影）；
 *  - ② ops on/off → modules.d/mcp.toml [mcp.servers] enabled 翻转（真手写条目表内翻转保留 command）
 *    + reload（ReloadReport 回传）+ catalog 出新态；
 *  - ③ ops trust → mcp-trust.json 登记（trustProjectServer：折叠项目路径 + fingerprintServer 指纹）；
 *  - ④ remove 仅 config 来源：预装/缺 name → 400；config 条目 → 200 + toml 节键删除；
 *  - ⑤ ops start（lazy 启动走 mcp.start）：已连接 / 非懒启动件 → 409；未知名 → 404；idle 预装件 →
 *    202 排队（后台触发连接——PATH 掐空令 npx 即败，catalog 观察 idle→failed 翻转即证服务真跑）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore } from "@orosus/core";
import { fingerprintServer, foldProjectPath } from "@orosus/mcp";
import { runWebSubcommand } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { t } from "../i18n/app.ts";

/** MCP 假 server（m4-3c T0 fixture——模块包连接类测试同靶子，stdio 模式真握手）。 */
const FIXTURE = fileURLToPath(new URL("../../../../tests/fixtures/mcp-fixture-server.mjs", import.meta.url));

/** 轮询等待（25ms 步进；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 引导门放行形态 config.toml（panel.test 同款——本文件不发 prompt，死端口即可）。 */
const writeProviderConfig = (home: string): void => {
  writeFileSync(
    join(home, "config.toml"),
    `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\ntype = "openai"\n`,
    "utf8",
  );
};

/** 用户层模块配置（<home>/modules.d/mcp.toml——[mcp.servers.<名>] 手写条目）。 */
const writeMcpToml = (home: string, body: string): void => {
  mkdirSync(join(home, "modules.d"), { recursive: true });
  writeFileSync(join(home, "modules.d", "mcp.toml"), body, "utf8");
};

/** 项目 .mcp.json（server cwd 这一层——模块信任门读点，§4-1）。 */
const writeProjectMcp = (cwd: string, servers: Record<string, unknown>): void => {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
};

/** 种子会话（真盘 jsonl——resume 托管面）。 */
const seedSession = async (home: string, cwd: string, sid: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  await store.append("session/label", { label: "MCP 面" });
  await store.close();
};

interface Stack {
  base: string;
  port: number;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（panel.test 同款 + chdir：mcp 模块的 .mcp.json 读点是
 *  process.cwd()（§4-1），测试进程切进会话 cwd 令项目层与模块同口径——at-menu-entries.test 同款先例）。 */
const startWebAt = async (home: string, cwd: string, sid: string): Promise<Stack> => {
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

/** GET /api/settings/mcp → servers 行表（status/ok 断言）。 */
interface McpRow {
  name: string;
  state: "connected" | "idle" | "failed" | "pending-confirm" | "disabled";
  toolCount?: number;
  tools: string[];
  failReason?: string;
  connectMs?: number;
  fingerprint?: string;
  source: "config" | "project" | "preload";
  transport: "stdio" | "http";
  command?: string;
  url?: string;
  deferred?: boolean;
}
const getMcp = async (s: Stack): Promise<McpRow[]> => {
  const r = await fetch(`${s.base}/api/settings/mcp`, { headers: s.auth });
  expect(r.status).toBe(200);
  const b = (await r.json()) as { ok: boolean; servers: McpRow[] };
  expect(b.ok).toBe(true);
  return b.servers;
};
const rowOf = (rows: McpRow[], name: string): McpRow => {
  const r = rows.find((x) => x.name === name);
  if (r === undefined) throw new Error(`catalog 无「${name}」行（现有：${rows.map((x) => x.name).join("、")}）`);
  return r;
};

/** POST /api/settings/mcp/ops（content-type 护栏合规形态）。 */
const ops = (s: Stack, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}/api/settings/mcp/ops`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** 手写条目 TOML 形（fixture 路径转正斜杠——TOML 基本串免转义）。 */
const fixPath = FIXTURE.replaceAll("\\", "/");
const BAD_CMD = "orosus-no-such-bin-t11"; // 启动即败（spawn ENOENT——failed 态的确定性来源）

describe("web T11：MCP 面 API", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  let prevHome: string | undefined;
  let prevCwd: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t11-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t11-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    prevHome = process.env["OROSUS_HOME"];
    prevCwd = process.cwd();
  });

  afterEach(() => {
    shutdownWebServer("test-cleanup"); // 幂等——失败用例兜底清退
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

  it("① GET /api/settings/mcp：catalog 行五态映射 + /panel connections 填充（T10 指针闭合）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd); // mcp 模块 .mcp.json 读点 = process.cwd()——项目层与模块同口径
    writeProviderConfig(home);
    writeMcpToml(home, [
      `[mcp.servers.fx]`,
      `command = "node"`,
      `args = ["${fixPath}"]`,
      ``,
      `[mcp.servers.bad]`,
      `command = "${BAD_CMD}"`,
      ``,
      `[mcp.servers.off-srv]`,
      `command = "node"`,
      `args = ["${fixPath}"]`,
      `enabled = false`,
      ``,
    ].join("\n"));
    writeProjectMcp(cwd, { "proj-srv": { command: "node", args: ["--version"] } });
    await seedSession(home, cwd, "s_mcp1");
    const s = await startWebAt(home, cwd, "s_mcp1");

    const rows = await getMcp(s);
    // 五态齐（connected=fx 真连 / failed=bad / disabled=off-srv / pending-confirm=proj-srv / idle=memory 预装）
    const fx = rowOf(rows, "fx");
    expect(fx.state).toBe("connected");
    expect(fx.source).toBe("config");
    expect(fx.transport).toBe("stdio");
    expect(fx.toolCount ?? 0).toBeGreaterThan(0);
    expect(fx.connectMs ?? -1).toBeGreaterThanOrEqual(0); // 首连被动计时（connected 行带）
    const bad = rowOf(rows, "bad");
    expect(bad.state).toBe("failed");
    expect(typeof bad.failReason).toBe("string");
    expect(bad.failReason!.length).toBeGreaterThan(0);
    expect(rowOf(rows, "off-srv").state).toBe("disabled");
    const proj = rowOf(rows, "proj-srv");
    expect(proj.state).toBe("pending-confirm");
    expect(proj.source).toBe("project");
    expect(proj.fingerprint).toMatch(/^[0-9a-f]{16,}$/); // 指纹门（审阅面数据）
    expect(proj.fingerprint).toBe(fingerprintServer({ command: "node", args: ["--version"] }));
    const mem = rowOf(rows, "memory"); // 预装件以真实为准（puppeteer/memory/context7/github/everything）
    expect(mem.state).toBe("idle");
    expect(mem.source).toBe("preload");
    expect(mem.deferred).toBe(true);
    expect(rowOf(rows, "everything").state).toBe("idle");

    // GET /panel：network.connections 填充（mcpConnRows 同投影——name/state/desc/connectMs）
    const pr = await fetch(`${s.base}/api/sessions/s_mcp1/panel`, { headers: s.auth });
    expect(pr.status).toBe(200);
    const p = (await pr.json()) as { network?: { connections: Array<{ name: string; state: string; desc: string; connectMs?: number }> } };
    const conns = p.network?.connections ?? [];
    expect(conns.length).toBeGreaterThan(0);
    const byName = new Map(conns.map((c) => [c.name, c]));
    expect(byName.get("fx")?.state).toBe("connected");
    expect(typeof byName.get("fx")?.connectMs).toBe("number");
    expect(byName.get("memory")?.state).toBe("idle");
    for (const c of conns) expect(c.desc.length).toBeGreaterThan(0); // t("conn.desc") 装配串

    await s.stop();
  }, 60_000);

  it("② ops on/off：[mcp.servers] enabled 翻转（表内翻转保留 command）+ reload 收口 + catalog 新态", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    writeMcpToml(home, `[mcp.servers.demo]\ncommand = "${BAD_CMD}"\n`);
    await seedSession(home, cwd, "s_tog2");
    const s = await startWebAt(home, cwd, "s_tog2");

    expect(rowOf(await getMcp(s), "demo").state).toBe("failed"); // 初态：启动即败（真手写条目）

    const off = await ops(s, { op: "off", name: "demo" });
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as { ok: boolean; text: string; report: { failed: unknown[]; reloaded: string[] } };
    expect(offBody.ok).toBe(true);
    expect(offBody.text.length).toBeGreaterThan(0); // toast 直显串（mcp-cmd t() 装配）
    expect(offBody.report.failed).toEqual([]); // reload 真跑（§4-12 直接 await）
    expect(offBody.report.reloaded).toContain("mcp");
    const toml1 = readFileSync(join(home, "modules.d", "mcp.toml"), "utf8");
    expect(toml1).toContain("enabled = false");
    expect(toml1).toContain(BAD_CMD); // 表内翻转：保留启动配置（非空壳覆盖）
    expect(rowOf(await getMcp(s), "demo").state).toBe("disabled");

    const on = await ops(s, { op: "on", name: "demo" });
    expect(on.status).toBe(200);
    expect(readFileSync(join(home, "modules.d", "mcp.toml"), "utf8")).toContain("enabled = true");
    await waitFor(async () => rowOf(await getMcp(s), "demo").state === "failed"); // 回启用即再连（再败）

    await s.stop();
  }, 60_000);

  it("③ ops trust：mcp-trust.json 登记（折叠项目路径 + 指纹）+ reload 收口", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    writeProjectMcp(cwd, { "proj-srv": { command: "node", args: ["--version"] } });
    await seedSession(home, cwd, "s_trust3");
    const s = await startWebAt(home, cwd, "s_trust3");

    const r = await ops(s, { op: "trust", name: "proj-srv" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; report?: { failed: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.report?.failed).toEqual([]); // wrote → reload（§4-12）

    // 信任库登记（trustProjectServer——按折叠项目路径 + server 名记 sha256 指纹）
    const trust = JSON.parse(readFileSync(join(home, "mcp-trust.json"), "utf8")) as { trusted: Record<string, Record<string, string>> };
    expect(trust.trusted[foldProjectPath(cwd)]?.["proj-srv"]).toBe(fingerprintServer({ command: "node", args: ["--version"] }));

    await s.stop();
  }, 60_000);

  it("④ ops remove 仅 config 来源：预装件/缺 name → 400；config 条目 → 200 + toml 节键删除", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    writeMcpToml(home, `[mcp.servers.mine]\ncommand = "${BAD_CMD}"\n`);
    await seedSession(home, cwd, "s_rm4");
    const s = await startWebAt(home, cwd, "s_rm4");

    // 预装件：不允许删除（runMcpCommand notYours 守卫——wrote:false → 400 + 原因文案）
    const pre = await ops(s, { op: "remove", name: "memory" });
    expect(pre.status).toBe(400);
    const preBody = (await pre.json()) as { ok: boolean; error: string };
    expect(preBody.ok).toBe(false);
    expect(preBody.error.length).toBeGreaterThan(0);
    expect(readFileSync(join(home, "modules.d", "mcp.toml"), "utf8")).toContain("mine"); // 拒绝路径零写盘

    // 缺 name → 400
    expect((await ops(s, { op: "remove" })).status).toBe(400);
    // 未知 op → 400
    expect((await ops(s, { op: "install-everything" })).status).toBe(400);

    // config 来源：可删（节键删除 + reload 后 catalog 行消失）
    const okr = await ops(s, { op: "remove", name: "mine" });
    expect(okr.status).toBe(200);
    expect(((await okr.json()) as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(join(home, "modules.d", "mcp.toml"), "utf8")).not.toContain("mine");
    const rows = await getMcp(s);
    expect(rows.find((x) => x.name === "mine")).toBeUndefined();
    expect(rowOf(rows, "memory").source).toBe("preload"); // 预装行不动

    await s.stop();
  }, 60_000);

  it("⑤ ops start（lazy 启动走 mcp.start）：已连接/非懒启动 → 409；未知名 → 404；idle 预装件 → 202 排队 + 态翻转", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    writeMcpToml(home, `[mcp.servers.fx]\ncommand = "node"\nargs = ["${fixPath}"]\n\n[mcp.servers.bad]\ncommand = "${BAD_CMD}"\n`);
    await seedSession(home, cwd, "s_start5");
    const s = await startWebAt(home, cwd, "s_start5");

    // 已连接行 → 409（已连接——无需启动）
    const conn = await ops(s, { op: "start", name: "fx" });
    expect(conn.status).toBe(409);
    expect(await conn.json()).toEqual({ ok: false, error: t("mcp.state.connected") });

    // 非懒启动件（手写失败行）→ 409（mcp.start.unknownLazy 同文案）
    const nl = await ops(s, { op: "start", name: "bad" });
    expect(nl.status).toBe(409);
    expect(((await nl.json()) as { error: string }).error).toBe(t("mcp.start.unknownLazy", { name: "bad" }));

    // 未知名 → 404
    expect((await ops(s, { op: "start", name: "no-such" })).status).toBe(404);

    // idle 预装件 → 202 排队：后台触发 mcp.start（连接最长 60s——npx 下载），前端轮询 catalog 观察翻转。
    // 测试掐空 PATH 令 npx 即败（无网络副作用）——idle→failed 翻转即证服务真跑。
    const emptyBin = mkdtempSync(join(tmpdir(), "orosus-t11-bin-"));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      const st = await ops(s, { op: "start", name: "memory" });
      expect(st.status).toBe(202);
      const stBody = (await st.json()) as { ok: boolean; starting?: boolean; name?: string };
      expect(stBody.ok).toBe(true);
      expect(stBody.starting).toBe(true);
      expect(stBody.name).toBe("memory");
      await waitFor(async () => rowOf(await getMcp(s), "memory").state === "failed");
      const row = rowOf(await getMcp(s), "memory");
      expect(row.state).toBe("failed");
      expect(typeof row.failReason).toBe("string"); // 启动失败原因可回显（E5 失败点击重连同源数据）
    } finally {
      process.env.PATH = prevPath;
      try { rmSync(emptyBin, { recursive: true, force: true }); } catch { /* 同 afterEach 口径 */ }
    }

    await s.stop();
  }, 60_000);
});
