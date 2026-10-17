/** web-i18n M2 伴生测试：GET /api/i18n/messages——web.* 切片/tag 解析/无会话降级（真栈样板照
 *  settings-data.test.ts——helper 连同依赖自该文件原样拷贝，文件内局部，不跨测试文件 import）：
 *  - ① 缺省 tag：config 未配置语言 → en-US（api-settings locale GET 同口径）；messages 只含
 *    web. 前缀键（切片过滤——TUI 键不外漏）；
 *  - ② ?tag= 指定（zh-TW 出繁体主表）/ 未知 tag 回落服务端解析值（config 口径）/ 空串同缺省；
 *  - ③ 无当前会话不 409——floor∪main 照常出表（语言包段缺席如实；startWebAt sid="" 空启）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore } from "@orosus/core";
import { runWebSubcommand } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";

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

/** 种子会话（真盘 jsonl——resume 托管面）。 */
const seedSession = async (home: string, cwd: string, sid: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  await store.append("session/label", { label: "译表数据面" });
  await store.close();
};

interface Stack {
  base: string;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（mcp-api.test 同款；sid="" = 空启无当前会话——locateSessionFile
 *  对空 sid 判不合形返回 undefined，handover 跳过，server 空启照常起服）。 */
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

describe("web-i18n M2：GET /api/i18n/messages", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  let prevHome: string | undefined;
  let prevCwd: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-i18n-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-i18n-cwd-"));
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

  it("① 缺省 tag：config 未配置语言 → en-US；messages 只含 web. 前缀键", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_i18n1");
    const s = await startWebAt(home, cwd, "s_i18n1");
    const g = await getJson(s, "/api/i18n/messages");
    expect(g.status).toBe(200);
    expect(g.body["tag"]).toBe("en-US"); // current === "" → en-US（api-settings locale GET 同口径）
    const msgs = g.body["messages"] as Record<string, string>;
    expect(msgs["web.shell.settings"]).toBe("Settings"); // M1 样板键（en-US 侧）
    expect(Object.keys(msgs).every((k) => k.startsWith("web."))).toBe(true); // 切片过滤
    await s.stop();
  }, 60_000);

  it("② ?tag= 指定（zh-TW）/未知回落/空串同缺省", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_i18n2");
    const s = await startWebAt(home, cwd, "s_i18n2");
    const tw = await getJson(s, "/api/i18n/messages?tag=zh-TW");
    expect(tw.body["tag"]).toBe("zh-TW");
    expect((tw.body["messages"] as Record<string, string>)["web.shell.settings"]).toBe("設定");
    const unk = await getJson(s, "/api/i18n/messages?tag=xx-YY");
    expect(unk.body["tag"]).toBe("en-US"); // 未知 tag 回落服务端解析值
    const empty = await getJson(s, "/api/i18n/messages?tag=");
    expect(empty.body["tag"]).toBe("en-US"); // 空串 = 缺省档
    await s.stop();
  }, 60_000);

  it("③ 无当前会话不 409——floor∪main 照常出（语言包段缺席如实）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    const s = await startWebAt(home, cwd, ""); // 空启——handover sid 不合形跳过，server 无当前会话
    const g = await getJson(s, "/api/i18n/messages?tag=zh-CN");
    expect(g.status).toBe(200);
    expect((g.body["messages"] as Record<string, string>)["web.common.loading"]).toBe("加载中…");
    await s.stop();
  }, 60_000);
});
