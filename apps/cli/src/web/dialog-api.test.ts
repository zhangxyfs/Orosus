/** web-dialog 批 T5 伴生测试：POST /api/sessions/:sid/dialog-event——设计 §6.4/12.2 全条。
 *  真栈（runWebSubcommand 进程内起服 + handover 托管种子会话——T4/T7 同款），经 webHostPool().host(sid)
 *  直达托管会话的 WebCommandUi 开活窗，走 HTTP 上行驱动：结构校验（400 族）/语义校验（noop 族）/
 *  三类合法事件与 revision 回执/用户 close/回调抛错窗保留/closed 回执。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore } from "@orosus/core";
import type { DialogEvent } from "@orosus/contracts/module";
import { runWebSubcommand, webHostPool } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { webCommandUiOf } from "./bridge-ui.ts";

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const writeProviderConfig = (home: string): void => {
  writeFileSync(join(home, "config.toml"), `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\ntype = "openai"\n`, "utf8");
};

const seedSession = async (home: string, cwd: string, sid: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  await store.close();
};

interface Stack {
  base: string;
  auth: Record<string, string>;
  sid: string;
  stop: () => Promise<void>;
}

const startWeb = async (home: string, cwd: string, sid: string): Promise<Stack> => {
  const lines: string[] = [];
  const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
  await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
  const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${inst.port}`,
    auth: { "x-orosus-token": inst.token, connection: "close" },
    sid,
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

const post = (s: Stack, path: string, body: unknown): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("web dialog T5：POST /dialog-event（设计 §6.4 + 12.2）", () => {
  let home: string;
  let cwd: string;
  let s: Stack;
  let dialogId: () => string;
  let openDialog: (opts?: { onEvent?: (e: DialogEvent) => void }) => string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "orosus-web-t5-api-"));
    cwd = mkdtempSync(join(tmpdir(), "orosus-web-t5-cwd-"));
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_dialog");
    s = await startWeb(home, cwd, "s_dialog");
    const hs = webHostPool()!.host("s_dialog");
    expect(hs).toBeDefined(); // handover 托管：写侧 host 在池
    const ui = webCommandUiOf(hs!)!;
    dialogId = () => ui.dialogRelay.snapshotFrame()?.id ?? "";
    openDialog = (opts = {}) => {
      ui.dialog({
        title: "测试窗",
        widgets: [
          { id: "l", kind: "list", interactive: true, items: ["甲", "乙"] },
          { id: "i", kind: "input", enterSubmit: true },
        ],
        ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
      });
      return dialogId();
    };
  });

  afterEach(async () => {
    await s.stop();
    for (const d of [home, cwd]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄迟到留给系统 tmp */ } }
  });

  it("① 三类合法事件：select/input/activate(list)/activate(input) 均到回调，revision 回执与 relay 状态一致", async () => {
    const seen: string[] = [];
    const id = openDialog({ onEvent: (e) => { seen.push(e.type); } });
    const r1 = await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, event: { type: "select", id: "l", index: 1 } });
    expect(await r1.json()).toEqual({ ok: true, revision: 1 }); // onEvent 返回 void：revision 不动
    await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, event: { type: "input", id: "i", text: "打字" } });
    await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, event: { type: "activate", id: "l", index: 0 } });
    const r4 = await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, event: { type: "activate", id: "i" } });
    const b4 = (await r4.json()) as { ok: boolean; revision?: number };
    expect(b4.ok).toBe(true);
    expect(seen).toEqual(["select", "input", "activate", "activate"]);
    const hs = webHostPool()!.host(s.sid)!;
    expect(b4.revision).toBe((webCommandUiOf(hs)!.dialogRelay.snapshotFrame() as { revision?: number })?.revision); // 回执与 relay 一致
  });

  it("② 用户 close：{ok}；此后该窗事件 noop；窗已从重放源消失", async () => {
    const id = openDialog();
    const r = await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, close: true });
    expect(await r.json()).toEqual({ ok: true });
    const r2 = await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, event: { type: "select", id: "l", index: 0 } });
    expect(await r2.json()).toEqual({ ok: true, noop: true }); // 已关窗
    const hs = webHostPool()!.host(s.sid)!;
    expect(webCommandUiOf(hs)!.dialogRelay.snapshotFrame()).toBeUndefined();
  });

  it("③ 400 族：坏 JSON/缺 id/event 与 close 同现或都缺/type 非法/input text 非串或带 index/select 缺 index/activate 非整数 index", async () => {
    const id = openDialog();
    const p = `/api/sessions/${s.sid}/dialog-event`;
    for (const [label, body] of [
      ["坏 JSON", "{oops"],
      ["缺 id", { event: { type: "select", id: "l", index: 0 } }],
      ["同现", { id, event: { type: "select", id: "l", index: 0 }, close: true }],
      ["都缺", { id }],
      ["type 非法", { id, event: { type: "wheel", id: "l" } }],
      ["控件 id 非串", { id, event: { type: "select", id: 7, index: 0 } }],
      ["input text 非串", { id, event: { type: "input", id: "i", text: 9 } }],
      ["input 带 index", { id, event: { type: "input", id: "i", text: "x", index: 0 } }],
      ["select 缺 index", { id, event: { type: "select", id: "l" } }],
      ["activate 非整数 index", { id, event: { type: "activate", id: "l", index: 1.5 } }],
    ] as const) {
      const r = await post(s, p, body);
      expect(r.status, label).toBe(400);
    }
  });

  it("④ noop 族：未知 id/消失控件/越界 index——不调 onEvent（幂等，无副作用）", async () => {
    let calls = 0;
    const id = openDialog({ onEvent: () => { calls += 1; } });
    const p = `/api/sessions/${s.sid}/dialog-event`;
    const r1 = await post(s, p, { id: "w999", event: { type: "select", id: "l", index: 0 } });
    expect(await r1.json()).toEqual({ ok: true, noop: true }); // 未知 dialog id
    const r2 = await post(s, p, { id, event: { type: "select", id: "gone", index: 0 } });
    expect(await r2.json()).toEqual({ ok: true, noop: true }); // 控件消失
    const r3 = await post(s, p, { id, event: { type: "activate", id: "l", index: 99 } });
    expect(await r3.json()).toEqual({ ok: true, noop: true }); // 越界（语义校验在 relay——需读快照）
    expect(calls).toBe(0);
  });

  it("⑤ 回调抛错：{ok} 且窗保留（后续事件仍可送达）", async () => {
    let calls = 0;
    const id = openDialog({ onEvent: () => { calls += 1; throw new Error("模块炸了"); } });
    const r = await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, event: { type: "select", id: "l", index: 0 } });
    expect(await r.json()).toEqual({ ok: true });
    const r2 = await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, event: { type: "select", id: "l", index: 0 } });
    expect(((await r2.json()) as { ok: boolean }).ok).toBe(true); // 窗仍活跃（notice 走 SSE 带内——relay 12.1-⑨ 已钉文案）
    expect(calls).toBe(2);
  });

  it("⑥ 回调内关窗：回执 {ok, closed:true}", async () => {
    const hs = webHostPool()!.host(s.sid)!;
    const ui = webCommandUiOf(hs)!;
    let handle: { close(): void } | undefined;
    const id = (() => {
      const spec = {
        title: "自关窗",
        widgets: [{ id: "l" as const, kind: "list" as const, interactive: true, items: ["甲"] }],
        onEvent: () => { handle!.close(); },
      };
      handle = ui.dialog(spec);
      return ui.dialogRelay.snapshotFrame()!.id;
    })();
    const r = await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, event: { type: "activate", id: "l", index: 0 } });
    expect(await r.json()).toEqual({ ok: true, closed: true });
  });

  it("⑦ 未知会话 → 404（/answer 同族路由约定）", async () => {
    const r = await post(s, "/api/sessions/s_none/dialog-event", { id: "w1", close: true });
    expect(r.status).toBe(404);
  });
});
