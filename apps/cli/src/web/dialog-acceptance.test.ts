/** web-dialog 批 T9 验收（设计 §12.4/§13）：记忆链路端到端 + 会话树冒烟——真栈（进程内起服 +
 *  handover 托管真会话 + 真 tool-peers/session-tree 模块），SSE 帧 + POST 往返全走 HTTP。
 *  - 记忆链路：密封记忆桶（MEMORY.md + 笔记）→ /tool-peers__memory → SSE 断言 dialog open(full +
 *    interactive list)；activate 笔记行 → dialog close → viewText(full + markdown + 真实标题 + 正文)；
 *    未知/越界激活 → noop 且无任何 viewText（不读文件）。
 *  - 会话树冒烟：full dialog 打开、select/activate 事件走通、不落只读 viewText fallback。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

import { encodeCwd, JsonlSessionStore } from "@orosus/core";
import { memoryBucketKey } from "@orosus/tool-peers";
import { runWebSubcommand, webHostPool } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

interface InteractionFrame { id?: string; kind?: string; op?: string; revision?: number; reset?: string; title?: string; layout?: unknown; markdown?: boolean; text?: string; widgets?: { id?: string; kind?: string; interactive?: boolean; items?: string[] }[] }

describe("web dialog T9：记忆链路验收（设计 12.4）", () => {
  let home: string;
  let cwd: string;
  let base: string;
  let auth: Record<string, string>;
  let stop: () => Promise<void>;
  let sseFrames: InteractionFrame[];
  let sseDestroy: () => void;
  let prevHome: string | undefined;
  const sid = "s_accept";

  beforeEach(async () => {
    prevHome = process.env["OROSUS_HOME"]; // tool-peers memoryBase 走运行期 orosusHome() 现读 env——进程级密封（hosted.test 同款）
    home = mkdtempSync(join(tmpdir(), "orosus-web-t9-"));
    cwd = mkdtempSync(join(tmpdir(), "orosus-web-t9-cwd-"));
    process.env["OROSUS_HOME"] = home;
    writeFileSync(join(home, "config.toml"), `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\ntype = "openai"\n`, "utf8");
    // 密封记忆桶（memoryDir = home/memories/projects/<memoryBucketKey(cwd)>/memory——roots.ts 同键）
    const memDir = join(home, "memories", "projects", memoryBucketKey(cwd), "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "MEMORY.md"), "# Shared Project Memory\n\n- [部署要点](deploy.md)\n", "utf8");
    writeFileSync(join(memDir, "deploy.md"), "---\nname: 部署要点\ndescription: 上线前检查清单\n---\n\n# 部署要点\n\n- 端口走 8080（t9-accept-标记）\n- 先跑全量测试再发布\n", "utf8");
    // 种子会话（handover 托管面；resume 发 session/start → tool-peers selfValue 就位）
    const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
    await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
    await store.close();
    const lines: string[] = [];
    const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
    await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
    const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
    base = `http://127.0.0.1:${inst.port}`;
    auth = { "x-orosus-token": inst.token, connection: "close" };
    stop = async () => { shutdownWebServer("test"); await run; };
    // SSE 订阅（interaction 帧断言面——bridge-ui 集成同款）
    sseFrames = [];
    let raw = "";
    const req = httpRequest({ host: "127.0.0.1", port: inst.port, path: `/api/sessions/${sid}/stream`, headers: auth }, (res) => {
      res.on("data", (c) => {
        raw += String(c);
        let i: number;
        while ((i = raw.indexOf("\n\n")) >= 0) {
          const block = raw.slice(0, i);
          raw = raw.slice(i + 2);
          const f: InteractionFrame = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              try { Object.assign(f, JSON.parse(line.slice(6)) as InteractionFrame); } catch { /* 非 JSON 数据行跳过 */ }
            }
          }
          if (f.kind !== undefined) sseFrames.push(f);
        }
      });
    });
    req.end();
    sseDestroy = () => req.destroy();
    await new Promise((r) => setTimeout(r, 800)); // SSE 连接就位（首帧 ev/phase 均可——订阅先于命令）
  });

  afterEach(async () => {
    sseDestroy();
    await stop();
    if (prevHome === undefined) delete process.env["OROSUS_HOME"];
    else process.env["OROSUS_HOME"] = prevHome;
    for (const d of [home, cwd]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄迟到留给系统 tmp */ } }
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

  const send = (text: string): Promise<Response> => post(`/api/sessions/${sid}/send`, { text });

  it("① 记忆链路：/tool-peers__memory → open(full + 装填壳) → update(装填 list 含笔记行) → activate → close → viewText(full + markdown + 真实标题 + 正文)", async () => {
    await waitFor(async () => (await send("/tool-peers__memory")).ok);
    await waitFor(() => sseFrames.some((f) => f.kind === "dialog" && f.op === "open"));
    const open = sseFrames.find((f) => f.kind === "dialog" && f.op === "open")!;
    expect(open.layout).toBe("center80"); // 2026-10-16 用户口令③「占屏 80%——全屏太大」（正文 viewText 仍 full）；不再掉进输入框上方只读条（设计 §1 根因句）
    expect(open.widgets![0]!.id).toBe("loading"); // 开窗即壳（2026-10-16）：开窗帧 = 装填态，列表在 update 帧随异步扫描抵达
    await waitFor(() => sseFrames.some((f) => f.kind === "dialog" && f.op === "update"));
    const upd = sseFrames.find((f) => f.kind === "dialog" && f.op === "update")!;
    const list = upd.widgets!.find((w) => w.id === "list")!;
    expect(list.kind).toBe("list");
    expect(list.interactive).toBe(true);
    const rowText = (it: unknown): string => (typeof it === "string" ? it : (it as { text: string }).text);
    expect(list.items!.some((it) => rowText(it).includes("部署要点"))).toBe(true);
    expect(list.items!.some((it) => rowText(it).includes("MEMORY.md"))).toBe(true); // 索引行在列

    const s1 = await post(`/api/sessions/${sid}/dialog-event`, { id: open.id, event: { type: "select", id: "list", index: 1 } });
    expect(((await s1.json()) as { ok: boolean }).ok).toBe(true);

    const a = await post(`/api/sessions/${sid}/dialog-event`, { id: open.id, event: { type: "activate", id: "list", index: 1 } });
    expect(((await a.json()) as { ok: boolean }).ok).toBe(true);
    // 帧序：dialog close → viewText(full + markdown + 真实标题)（设计 §4 写链顺序保证）
    await waitFor(() => sseFrames.some((f) => f.kind === "viewText" && f.layout === "full"));
    const closeIdx = sseFrames.findIndex((f) => f.kind === "dialog" && f.op === "close");
    const vtIdx = sseFrames.findIndex((f) => f.kind === "viewText" && f.layout === "full");
    expect(closeIdx).toBeGreaterThan(-1);
    expect(vtIdx).toBeGreaterThan(closeIdx);
    const vt = sseFrames[vtIdx]!;
    expect(vt.title).toBe("部署要点"); // 真实文件名标题——不再硬编码「查看」
    expect(vt.markdown).toBe(true);
    expect(vt.text).toContain("t9-accept-标记"); // 正文 = 笔记文件内容
    expect((vt as { back?: string }).back).toBe("/tool-peers__memory"); // 走查④（2026-10-16）：详情帧带返回命令——GUI 关窗回列表
  }, 40_000);

  it("② 未知/越界激活不读文件：noop 回执且无 viewText 帧", async () => {
    await waitFor(async () => (await send("/tool-peers__memory")).ok);
    await waitFor(() => sseFrames.some((f) => f.kind === "dialog" && f.op === "update")); // 装填完成后再打事件（装填期 activate 本就空转）
    const open = sseFrames.find((f) => f.kind === "dialog" && f.op === "open")!;
    const viewTextCountBefore = sseFrames.filter((f) => f.kind === "viewText").length;
    const n1 = await post(`/api/sessions/${sid}/dialog-event`, { id: open.id, event: { type: "activate", id: "list", index: 99 } });
    expect(await n1.json()).toEqual({ ok: true, noop: true }); // 越界 → relay 语义校验挡下
    const n2 = await post(`/api/sessions/${sid}/dialog-event`, { id: "w999", event: { type: "activate", id: "list", index: 0 } });
    expect(await n2.json()).toEqual({ ok: true, noop: true }); // 未知 dialog id
    await new Promise((r) => setTimeout(r, 500));
    expect(sseFrames.filter((f) => f.kind === "viewText").length).toBe(viewTextCountBefore); // 无文件读取副作用面
  }, 40_000);
});

describe("web dialog T9：会话树冒烟（设计 12.4 第二验收）", () => {
  let home: string;
  let cwd: string;
  let base: string;
  let auth: Record<string, string>;
  let stop: () => Promise<void>;
  let sseFrames: InteractionFrame[];
  let sseDestroy: () => void;
  const sid = "s_tree_smoke";

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "orosus-web-t9-tree-"));
    cwd = mkdtempSync(join(tmpdir(), "orosus-web-t9-tree-cwd-"));
    writeFileSync(join(home, "config.toml"), `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\ntype = "openai"\n`, "utf8");
    const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
    await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
    await store.close();
    const lines: string[] = [];
    const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
    await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
    const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
    base = `http://127.0.0.1:${inst.port}`;
    auth = { "x-orosus-token": inst.token, connection: "close" };
    stop = async () => { shutdownWebServer("test"); await run; };
    sseFrames = [];
    let raw = "";
    const req = httpRequest({ host: "127.0.0.1", port: inst.port, path: `/api/sessions/${sid}/stream`, headers: auth }, (res) => {
      res.on("data", (c) => {
        raw += String(c);
        let i: number;
        while ((i = raw.indexOf("\n\n")) >= 0) {
          const block = raw.slice(0, i);
          raw = raw.slice(i + 2);
          const f: InteractionFrame = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              try { Object.assign(f, JSON.parse(line.slice(6)) as InteractionFrame); } catch { /* 非 JSON 数据行跳过 */ }
            }
          }
          if (f.kind !== undefined) sseFrames.push(f);
        }
      });
    });
    req.end();
    sseDestroy = () => req.destroy();
  });

  afterEach(async () => {
    sseDestroy();
    await stop();
    for (const d of [home, cwd]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄迟到留给系统 tmp */ } }
  });

  it("③ /session-tree__view：full dialog 打开 + select/activate 走通 + 不落只读 fallback", async () => {
    await waitFor(async () => (await fetch(`${base}/api/sessions/${sid}/send`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ text: "/session-tree__view" }) })).ok);
    await waitFor(() => sseFrames.some((f) => f.kind === "dialog" && f.op === "open"));
    const open = sseFrames.find((f) => f.kind === "dialog" && f.op === "open")!;
    expect(open.layout).toBe("full");
    const list = open.widgets!.find((w) => w.id === "tree")!;
    expect(list.kind).toBe("list");
    expect(list.interactive).toBe(true);
    expect((list.items ?? []).length).toBeGreaterThan(0);
    const s = await fetch(`${base}/api/sessions/${sid}/dialog-event`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: open.id, event: { type: "select", id: "tree", index: 0 } }) });
    expect(((await s.json()) as { ok: boolean }).ok).toBe(true); // select 事件走通
    const a = await fetch(`${base}/api/sessions/${sid}/dialog-event`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: open.id, event: { type: "activate", id: "tree", index: 0 } }) });
    expect(((await a.json()) as { ok: boolean }).ok).toBe(true); // activate 走通（自身枝 = 无切换，窗保留）
    await new Promise((r) => setTimeout(r, 500));
    expect(sseFrames.some((f) => f.kind === "viewText" && (f.title ?? "").includes("会话树"))).toBe(false); // 不落只读 viewText fallback——基座对所有消费方通用
    // 窗仍活跃（重放源可取快照）
    const hs = webHostPool()!.host(sid);
    expect(hs).toBeDefined();
  }, 40_000);
});
