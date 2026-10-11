/** web 批 T9 伴生测试（动作面）：B11-B13 会话动作——brief ⑩⑪⑫ 逐条 + renderMarkdown 纯函数单测。
 *  ⑩ 归档链（B12：标记文件 ISO → 列表过滤/已归档页双时间 → unarchive 回列 + cwd 联动 unhide；
 *  fresh 空会话 archive → 400）；⑪ 删除守卫（B11：外部活会话 live.json/锁 → 409；死会话删尽；
 *  本进程托管〔含当前〕先 close 再删尽）；⑫ 导出（B11：text/markdown + attachment 头 + 事件渲染）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { encodeCwd, JsonlSessionStore, type SessionEvent } from "@orosus/core";
import { runWebSubcommand, webHostPool } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { renderMarkdown } from "./session-actions.ts";

/** 轮询等待（25ms 步进；谓词可异步；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 引导门放行形态 config.toml（死端口 provider——turn 快速失败收尾）。 */
const writeProviderConfig = (home: string): void => {
  writeFileSync(join(home, "config.toml"), `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\ntype = "openai"\n`, "utf8");
};

/** 种子会话（header + 可选 label/user/assistant/tool——fresh 判据与导出渲染用）。 */
const seedSession = async (
  home: string,
  cwd: string,
  sid: string,
  opts: { label?: string; user?: string; assistant?: string; tool?: { name: string; args?: Record<string, unknown> } } = {},
): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  if (opts.label !== undefined) await store.append("session/label", { label: opts.label });
  if (opts.user !== undefined) await store.append("user/message", { content: [{ kind: "text", text: opts.user }] });
  if (opts.assistant !== undefined) await store.append("assistant/message", { content: [{ kind: "text", text: opts.assistant }] });
  if (opts.tool !== undefined) await store.append("tool/call", { name: opts.tool.name, ...(opts.tool.args !== undefined ? { args: opts.tool.args } : {}), callId: "call_seed" });
  await store.close();
};

interface Stack {
  base: string;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（T4/T7 同款）。 */
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

const get = (s: Stack, path: string): Promise<Response> => fetch(`${s.base}${path}`, { headers: s.auth });
const post = (s: Stack, path: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });
const del = (s: Stack, path: string): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "DELETE", headers: { ...s.auth, "content-type": "application/json" } });

/** 真驻留子进程（活 pid 源——live.json/锁 fabrication 用）。 */
const spawnSleeper = async (): Promise<{ pid: number; kill: () => void }> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 400));
  return { pid: child.pid!, kill: () => { try { child.kill(); } catch { /* 已退 */ } } };
};

/** fabricate 事件（renderMarkdown 单测用——信封字段补齐）。 */
const fakeEvent = (seq: number, type: string, fields: Record<string, unknown>): SessionEvent =>
  ({ v: 1, id: `e${seq}`, parentId: null, seq, ts: new Date(0).toISOString(), type, ...fields }) as SessionEvent;

describe("web T9：会话动作（归档/删除守卫/导出）", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  const killers: Array<() => void> = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t9a-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t9a-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    prevHome = process.env["OROSUS_HOME"];
  });

  afterEach(() => {
    shutdownWebServer("test-cleanup");
    if (prevHome === undefined) delete process.env["OROSUS_HOME"];
    else process.env["OROSUS_HOME"] = prevHome;
    for (const k of killers.splice(0)) {
      try { k(); } catch { /* 已退 */ }
    }
    for (const c of cwds.splice(0)) {
      try { rmSync(c, { recursive: true, force: true }); } catch { /* 迟到句柄留给系统 tmp */ }
    }
    while (homes.length > 0) {
      const h = homes.pop()!;
      try { rmSync(h, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  });

  it("⑩ 归档链（B12）：标记 ISO → 列表过滤 + 已归档页（title/cwd/双时间）→ unarchive 回列 + cwd 联动 unhide；fresh archive → 400", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    await seedSession(home, cwdA, "s_hand", { user: "交接会话" });
    await seedSession(home, cwdA, "s_arch", { label: "归档目标", user: "有内容可归档" });
    await seedSession(home, cwdB, "s_b2", { user: "B 桶会话" });
    const s = await startWeb(home, cwdA, "s_hand");
    const marker = join(home, "sessions", encodeCwd(cwdA), "s_arch", "agents", "archived");

    const arch = await post(s, "/api/sessions/s_arch/archive", {});
    expect(arch.status).toBe(200);
    expect(await arch.json()).toEqual({ ok: true });
    expect(existsSync(marker)).toBe(true); // 标记文件（B12 盘上标记）
    const iso = readFileSync(marker, "utf8").trim();
    expect(Number.isFinite(Date.parse(iso))).toBe(true); // 内容 = ISO 一行
    expect(Math.abs(Date.now() - Date.parse(iso))).toBeLessThan(60_000);

    const list = (await (await get(s, "/api/sessions")).json()) as { groups: { sessions: { sid: string }[] }[] };
    expect(list.groups.flatMap((g) => g.sessions.map((x) => x.sid))).not.toContain("s_arch"); // 列表过滤

    const ar = (await (await get(s, "/api/archived")).json()) as { items: { sid: string; title: string; cwd: string; archivedAt: number; createdAt: number }[] };
    expect(ar.items).toHaveLength(1);
    expect(ar.items[0]!.sid).toBe("s_arch");
    expect(ar.items[0]!.title).toBe("归档目标");
    expect(ar.items[0]!.cwd).toBe(cwdA);
    expect(typeof ar.items[0]!.archivedAt).toBe("number"); // 双时间齐（归档时刻 epoch ms）
    expect(Math.abs(Date.now() - ar.items[0]!.archivedAt)).toBeLessThan(60_000);
    expect(typeof ar.items[0]!.createdAt).toBe("number"); // 创建时刻 epoch ms
    expect(ar.items[0]!.createdAt).toBeGreaterThan(0);

    // unarchive + cwd 联动 unhide：先 hide B（s_b2 所在工作区）→ 归档/恢复 s_b2 → B 回列
    await post(s, "/api/workspaces/hide", { cwd: cwdB });
    await post(s, "/api/sessions/s_b2/archive", {});
    const un2 = await post(s, "/api/sessions/s_b2/unarchive", {});
    expect(un2.status).toBe(200);
    const list2 = (await (await get(s, "/api/sessions")).json()) as { groups: { cwd: string; sessions: { sid: string }[] }[] };
    expect(list2.groups.some((g) => g.cwd === cwdB && g.sessions.some((x) => x.sid === "s_b2"))).toBe(true); // 恢复即找回（§3 端点注释）
    expect(((await (await get(s, "/api/archived")).json()) as { items: unknown[] }).items).toHaveLength(1); // s_b2 已出已归档页（s_arch 仍在）

    const un = await post(s, "/api/sessions/s_arch/unarchive", {});
    expect(un.status).toBe(200);
    expect(existsSync(marker)).toBe(false); // 恢复 = 删标记文件
    const list3 = (await (await get(s, "/api/sessions")).json()) as { groups: { sessions: { sid: string }[] }[] };
    expect(list3.groups.flatMap((g) => g.sessions.map((x) => x.sid))).toContain("s_arch"); // 回列
    expect(((await (await get(s, "/api/archived")).json()) as { items: unknown[] }).items).toHaveLength(0);

    // fresh 空会话 archive → 400（B12：fresh 不出现归档钮的服务端口径）
    const fresh = await post(s, "/api/sessions", { cwd: cwdA });
    const freshSid = ((await fresh.json()) as { sid: string }).sid;
    const bad = await post(s, `/api/sessions/${freshSid}/archive`, {});
    expect(bad.status).toBe(400);
    await s.stop();
  }, 60_000);

  it("⑪ 删除守卫（B11）：外部活会话（live.json 活 pid / lock 活锁）→ 409；死会话删尽；本进程托管（非当前/当前）先 close 再删尽", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdC = tmpCwd();
    await seedSession(home, cwdA, "s_hand", { user: "交接会话" });
    await seedSession(home, cwdC, "s_ext_live", { user: "外部活会话" });
    await seedSession(home, cwdC, "s_ext_lock", { user: "外部锁会话" });
    await seedSession(home, cwdC, "s_dead", { user: "死会话" });
    const bucketC = join(home, "sessions", encodeCwd(cwdC));
    const sleeper = await spawnSleeper();
    killers.push(sleeper.kill);
    writeFileSync(join(bucketC, "s_ext_live", "live.json"), JSON.stringify({
      v: 1, sid: "s_ext_live", pid: sleeper.pid, token: "fabricate", kind: "tui",
      phase: "running", startedAt: Date.now(), lastEventAt: Date.now(),
    }), "utf8");
    writeFileSync(join(bucketC, "s_ext_lock", "agents", "session.lock"), `${sleeper.pid}\n${new Date().toISOString()}\n`, "utf8");
    const s = await startWeb(home, cwdA, "s_hand");
    const pool = webHostPool()!;

    // 外部活会话（live.json 非本进程 pid 活）→ 409
    const d1 = await del(s, "/api/sessions/s_ext_live");
    expect(d1.status).toBe(409);
    expect(((await d1.json()) as { ok: boolean }).ok).toBe(false);
    expect(existsSync(join(bucketC, "s_ext_live"))).toBe(true); // 未删
    // 外部活锁（lock 活 pid）→ 409
    const d2 = await del(s, "/api/sessions/s_ext_lock");
    expect(d2.status).toBe(409);
    expect(existsSync(join(bucketC, "s_ext_lock"))).toBe(true);

    // 死会话 → 目录删尽（purgeSessionDir）
    const d3 = await del(s, "/api/sessions/s_dead");
    expect(d3.status).toBe(200);
    expect(await d3.json()).toEqual({ ok: true });
    expect(existsSync(join(bucketC, "s_dead"))).toBe(false);
    const d3b = await del(s, "/api/sessions/s_dead"); // 已删 → 404
    expect(d3b.status).toBe(404);

    // 本进程托管非当前会话（fresh 创建）→ 先 close（presence 撤）再删尽
    const created = await post(s, "/api/sessions", { cwd: cwdC });
    const hostedSid = ((await created.json()) as { sid: string }).sid;
    expect(pool.host(hostedSid)).toBeDefined();
    const back = await post(s, "/api/sessions", { resumeSid: "s_hand" }); // 切回 s_hand（当前）——新会话变非当前
    expect(back.status).toBe(200);
    const d4 = await del(s, `/api/sessions/${hostedSid}`);
    expect(d4.status).toBe(200);
    expect(existsSync(join(bucketC, hostedSid))).toBe(false); // 删尽（含 presence 壳目录）
    expect(pool.host(hostedSid)).toBeUndefined(); // 已出池

    // 当前会话同款：先 close（presence 撤——live.json 消失）再删尽
    const bucketA = join(home, "sessions", encodeCwd(cwdA));
    expect(existsSync(join(bucketA, "s_hand", "live.json"))).toBe(true); // 托管期 presence 在
    const d5 = await del(s, "/api/sessions/s_hand");
    expect(d5.status).toBe(200);
    expect(existsSync(join(bucketA, "s_hand"))).toBe(false); // 目录删尽
    expect(pool.current()).toBeUndefined(); // 游标清
    await s.stop();
  }, 60_000);

  it("⑫ 导出（B11）：export.md → text/markdown + attachment 头；内容含 user/assistant 消息与工具行摘要", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    await seedSession(home, cwdA, "s_hand", { user: "交接会话" });
    await seedSession(home, cwdA, "s_export", {
      label: "导出样本",
      user: "帮我查一下库存",
      assistant: "库存还有 42 件",
      tool: { name: "bash", args: { command: "ls -la" } },
    });
    const s = await startWeb(home, cwdA, "s_hand");

    const r = await get(s, "/api/sessions/s_export/export.md");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/markdown");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    const md = await r.text();
    expect(md).toContain("导出样本"); // 标题（session/label）
    expect(md).toContain("帮我查一下库存"); // user/message
    expect(md).toContain("库存还有 42 件"); // assistant/message
    expect(md).toContain("bash"); // 工具行摘要
    expect(md).toContain("ls -la"); // 工具参数摘要
    await s.stop();
  }, 60_000);

  it("renderMarkdown 纯函数：user/assistant 分节、thinking 折叠引用、工具行带关键参数", () => {
    const md = renderMarkdown([
      fakeEvent(1, "session/header", { cwd: "/tmp/x", parentSession: null }),
      fakeEvent(2, "user/message", { content: [{ kind: "text", text: "第一问" }] }),
      fakeEvent(3, "assistant/message", { content: [{ kind: "thinking", text: "先想想" }, { kind: "text", text: "第一答" }] }),
      fakeEvent(4, "tool/call", { name: "fs__read", args: { path: "a.txt", other: "b" }, callId: "c1" }),
      fakeEvent(5, "assistant/message", { content: [{ kind: "text", text: "第二答" }] }),
    ]);
    expect(md).toContain("## 用户");
    expect(md).toContain("第一问");
    expect(md).toContain("## 助手");
    expect(md).toContain("先想想"); // thinking 折叠渲染
    expect(md).toContain("第一答");
    expect(md).toContain("fs__read");
    expect(md).toContain("a.txt"); // 关键参数摘要（path 优先）
    expect(md).not.toContain("other"); // 非关键参数不进摘要
    expect(md).toContain("第二答");
  }, 30_000);
});
