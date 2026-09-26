import { describe, it, expect, afterEach } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore, repairFile } from "./jsonl.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("JsonlSessionStore", () => {
  it("append 落盘为 JSONL，flush 后可全量读回", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-"));
    const s = new JsonlSessionStore({ dir });
    await s.append("session/header", { format: 1, cwd: "/r", parentSession: null });
    await s.append("user/message", { content: [] });
    await s.flush();
    const lines = readFileSync(join(dir, s.sessionId, "agents", "session.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("session/header");
    expect(JSON.parse(lines[1]!).seq).toBe(2);
    await s.close();
  });

  it("POSIX 上文件权限为 0o600、会话目录与 agents/ 0o700；Windows 降级不报错", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-"));
    const s = new JsonlSessionStore({ dir });
    await s.append("x");
    await s.flush();
    if (process.platform !== "win32") {
      expect(statSync(join(dir, s.sessionId, "agents", "session.jsonl")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, s.sessionId, "agents")).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, s.sessionId)).mode & 0o777).toBe(0o700);
    }
    await s.close();
  });

  it("repairFile 截断 torn tail 并给未闭合 turn 补 interrupted", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-"));
    const file = join(dir, "s_test.jsonl");
    const good = [
      JSON.stringify({ v: 1, id: "e_1", parentId: null, seq: 1, ts: "t", type: "session/header" }),
      JSON.stringify({ v: 1, id: "e_2", parentId: "e_1", seq: 2, ts: "t", type: "turn/start" }),
    ].join("\n");
    writeFileSync(file, good + "\n" + '{"v":1,"id":"e_3","typ'); // 撕裂尾部
    const r = repairFile(file);
    expect(r.truncated).toBe(true);
    expect(r.interruptedClosed).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[2].type).toBe("turn/end");
    expect(lines[2].kind).toBe("interrupted");
  });

  it("repairFile 规范化缺尾换行：防后续 append 行合并（崩溃切口落在换行前）", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-"));
    const file = join(dir, "s_cut.jsonl");
    writeFileSync(file, JSON.stringify({ v: 1, id: "e_1", parentId: null, seq: 1, ts: "t", type: "session/header" })); // 刻意无尾 \n
    expect(repairFile(file).truncated).toBe(false); // 合法 JSON：不算 torn tail
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true); // 但被规范化补了换行
    appendFileSync(file, JSON.stringify({ v: 1, id: "e_2", parentId: "e_1", seq: 2, ts: "t", type: "user/message" }) + "\n");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2); // 未规范化的话两条会合并成一行
    expect(JSON.parse(lines[1]!).seq).toBe(2);
  });

  it("all() 内存镜像 + 重开同 sessionId 实例从磁盘恢复（默认路径——loop 投影依赖 all()）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-"));
    const s1 = new JsonlSessionStore({ dir, sessionId: "s_fixed" });
    await s1.append("session/header", { format: 1 });
    await s1.append("user/message", { content: [] });
    await s1.close();
    const s2 = new JsonlSessionStore({ dir, sessionId: "s_fixed" });
    const all = await s2.all();
    expect(all.map((e) => e.type)).toEqual(["session/header", "user/message"]);
    expect(await s2.append("x")).toMatchObject({ seq: 3, parentId: all[1]!.id }); // 恢复后 seq/parentId 链延续
    await s2.close();
  });

  it("会话树批 T3 目录化：新会话落 <桶>/<sid>/agents/session.jsonl；懒建保持——零 append 零落盘连会话目录也不建", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-tree-"));
    const s = new JsonlSessionStore({ dir, sessionId: "s_lazy" });
    expect(existsSync(join(dir, "s_lazy"))).toBe(false); // 懒建：连会话目录也不建（D46 语义保持）
    await s.append("session/header", { format: 1 });
    await s.flush();
    expect(existsSync(join(dir, "s_lazy", "agents", "session.jsonl"))).toBe(true); // 首写建目录 + 主文件
    await s.close();
    // resume 打开既有目录形态会话原位续写
    const s2 = new JsonlSessionStore({ dir, sessionId: "s_lazy" });
    expect(await s2.append("user/message", { content: [] })).toMatchObject({ seq: 2 }); // 原文件续写（seq 延续）
    await s2.flush();
    expect(readFileSync(join(dir, "s_lazy", "agents", "session.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    await s2.close();
  });

  it("lifetimeUsage 跨会话累计（/usage 走查：重启归零是口径 bug——同目录全部 *.jsonl 的 usage chunk 求和）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-"));
    const s1 = new JsonlSessionStore({ dir, sessionId: "s_a" });
    await s1.append("assistant/chunk", { chunk: { type: "usage", input: 10, output: 4 } });
    await s1.close();
    const s2 = new JsonlSessionStore({ dir, sessionId: "s_b" });
    await s2.append("assistant/chunk", { chunk: { type: "usage", input: 7, output: 2 } });
    await s2.append("assistant/chunk", { chunk: { type: "usage", input: 3, output: 1 } });
    await s2.close();
    const s3 = new JsonlSessionStore({ dir, sessionId: "s_c" }); // 空会话（无任何 usage）
    await s3.close();
    const s4 = new JsonlSessionStore({ dir, sessionId: "s_d" }); // 当前会话：内存态 usage 也计入
    await s4.append("assistant/chunk", { chunk: { type: "usage", input: 100, output: 50 } });
    expect(await s4.lifetimeUsage()).toEqual({ input: 120, output: 57, sessions: 3 }); // 3 = 有用量的会话数，空会话不计
    await s4.close();
  });
});

describe("sumUsage / lifetimeUsage 双形态（M4-1 T5/D45：新形态 usage 落 assistant/message）", () => {
  it("新形态：assistant/message.usage 计入（断流后无 chunk 事件）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-dual-"));
    const s = new JsonlSessionStore({ dir, sessionId: "s_new" });
    await s.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage: { input: 11, output: 4 } });
    expect(await s.lifetimeUsage()).toEqual({ input: 11, output: 4, sessions: 1 });
    await s.close();
  });

  it("混合（旧 chunk + 新 message 各自计一次，不双算——一事件只属一形态）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-dual-"));
    const legacy = new JsonlSessionStore({ dir, sessionId: "s_old" });
    await legacy.append("assistant/chunk", { chunk: { type: "usage", input: 10, output: 4 } });
    await legacy.close();
    const cur = new JsonlSessionStore({ dir, sessionId: "s_cur" }); // 旧会话续聊后新 turn 落 message.usage
    await cur.append("assistant/message", { content: [{ kind: "text", text: "续" }], usage: { input: 5, output: 1 } });
    expect(await cur.lifetimeUsage()).toEqual({ input: 15, output: 5, sessions: 2 });
    await cur.close();
  });
});

describe("/fork 用量去重（M4-2 T4/B3——子体 lineage 以父计，cc-haha 同款）", () => {
  it("fork 子体 usage 跳过——父已含", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-fork-"));
    // 父：无 parentSession
    const parent = new JsonlSessionStore({ dir, sessionId: "s_parent" });
    await parent.append("session/header", { cwd: "/x", parentSession: null });
    await parent.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage: { input: 10, output: 4 } });
    await parent.close();
    // 子：parentSession = 父 sid
    const child = new JsonlSessionStore({ dir, sessionId: "s_child" });
    await child.append("session/header", { cwd: "/x", parentSession: "s_parent" });
    await child.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage: { input: 5, output: 1 } });
    await child.close();
    // 子会话视角：自身 5/1 跳过 + 父文件 10/4 计入 = 10/4/1（不双算）
    expect(await child.lifetimeUsage()).toEqual({ input: 10, output: 4, sessions: 1 });
    // 第三会话视角：父计入、子文件整个跳过
    const third = new JsonlSessionStore({ dir, sessionId: "s_third" });
    await third.append("session/header", { cwd: "/x", parentSession: null });
    expect(await third.lifetimeUsage()).toEqual({ input: 10, output: 4, sessions: 1 });
    await third.close();
    // 父会话视角（resume 父后 /usage）：子体不回灌
    const parentResumed = new JsonlSessionStore({ dir, sessionId: "s_parent" });
    expect(await parentResumed.lifetimeUsage()).toEqual({ input: 10, output: 4, sessions: 1 });
    await parentResumed.close();
  });
});
