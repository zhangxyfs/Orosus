/** web-dialog 批 T6 伴生测试：模块启停端点的 owner 关窗接线（设计 §5.1/§10，溯源 4）。
 *  真栈（runWebSubcommand 进程内 + handover 托管）+ 池内直达 WebCommandUi 开带 owner 的活窗
 *  （owner 直书 spec——core ownerTagUi 注入机制的等价形态），经 toggle 端点真实 reload：
 *  卸载 diff 出消失模块 → SSE 收 close 帧、后续该窗事件 noop；挂载方向不误关别人的窗。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

import { encodeCwd, JsonlSessionStore } from "@orosus/core";
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
  port: number;
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
    port: inst.port,
    auth: { "x-orosus-token": inst.token, connection: "close" },
    sid,
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

const post = (s: Stack, path: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** SSE 订阅（bridge-ui.test openSse 同款——interaction 帧断言面）。 */
const openSse = (s: Stack, pathQ: string): {
  frames: { event?: string; data: string }[];
  destroy: () => void;
} => {
  const frames: { event?: string; data: string }[] = [];
  let raw = "";
  const req = httpRequest({ host: "127.0.0.1", port: s.port, path: pathQ, headers: s.auth }, (res) => {
    res.on("data", (c) => {
      raw += String(c);
      let i: number;
      while ((i = raw.indexOf("\n\n")) >= 0) {
        const block = raw.slice(0, i);
        raw = raw.slice(i + 2);
        const f: { event?: string; data: string } = { data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) f.event = line.slice(7);
          else if (line.startsWith("data: ")) f.data = (f.data === "" ? "" : f.data + "\n") + line.slice(6);
        }
        frames.push(f);
      }
    });
  });
  req.end();
  return { frames, destroy: () => req.destroy() };
};

describe("web dialog T6：模块启停的 owner 关窗（设计 §5.1）", () => {
  let home: string;
  let cwd: string;
  let s: Stack;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "orosus-web-t6-"));
    cwd = mkdtempSync(join(tmpdir(), "orosus-web-t6-cwd-"));
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_unload");
    s = await startWeb(home, cwd, "s_unload");
  });

  afterEach(async () => {
    await s.stop();
    for (const d of [home, cwd]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄迟到留给系统 tmp */ } }
  });

  const uiOf = () => webCommandUiOf(webHostPool()!.host(s.sid)!)!;

  it("① 卸载关窗：tool-todo 名下活窗 → toggle off → SSE 收 close 帧 + 后续该窗事件 noop", async () => {
    const sse = openSse(s, `/api/sessions/${s.sid}/stream`);
    const ui = uiOf();
    ui.dialog({ title: "待卸载模块的窗", widgets: [{ id: "l", kind: "list", interactive: true, items: ["甲"] }], owner: "tool-todo" });
    const id = ui.dialogRelay.snapshotFrame()!.id;
    await waitFor(() => sse.frames.some((f) => f.event === "interaction" && f.data.includes(id) && f.data.includes("\"open\"")));

    const r = await post(s, `/api/sessions/${s.sid}/modules/tool-todo/toggle`, { enabled: false });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    await waitFor(() => sse.frames.some((f) => f.event === "interaction" && f.data.includes(id) && f.data.includes("\"close\""))); // SSE 收到 close 帧
    expect(ui.dialogRelay.snapshotFrame()).toBeUndefined();

    const ev = await post(s, `/api/sessions/${s.sid}/dialog-event`, { id, event: { type: "select", id: "l", index: 0 } });
    expect(await ev.json()).toEqual({ ok: true, noop: true }); // 迟到事件不复活窗口
    sse.destroy();
  }, 30_000);

  it("② 挂载不误关：toggle on 别的模块 → 他人名下的窗仍在", async () => {
    const ui = uiOf();
    ui.dialog({ title: "无辜的窗", widgets: [{ id: "l", kind: "list", interactive: true, items: ["甲"] }], owner: "session-tree" });
    const id = ui.dialogRelay.snapshotFrame()!.id;
    const r = await post(s, `/api/sessions/${s.sid}/modules/tool-todo/toggle`, { enabled: true });
    expect(r.status).toBe(200);
    const snap = ui.dialogRelay.snapshotFrame();
    expect(snap).toBeDefined(); // 挂载方向 diff 无消失模块——不误关
    expect(snap!.id).toBe(id);
    ui.dialogRelay.closeActive();
  }, 30_000);
});
