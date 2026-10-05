import { describe, it, expect, afterEach, vi } from "vitest";
import { appendFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore, repairFile, sessionAppendFlag } from "./jsonl.ts";
import { sqliteAvailable } from "./sqlite.ts";

// T1（m5-resume-perf）读盘计数：node:fs ESM 命名空间不可 spyOn（Cannot redefine），部分替换 mock 拦截
// 所有导入方（jsonl.ts 源码内）的 readFileSync——包装 actual，行为零变化，仅多记账。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

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

describe("CS-06 兄弟会话 subagent-usage 计入口径（2026-09-28 code review）", () => {
  it("兄弟会话文件的 session/subagent-usage 行计入 lifetimeUsage——与当前会话口径（sumUsage）一致，重启后不再丢失", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs06-"));
    // 兄弟会话（磁盘态）：message 用量 + 子代理账
    const sibling = new JsonlSessionStore({ dir, sessionId: "s_sib" });
    await sibling.append("session/header", { format: 1 });
    await sibling.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage: { input: 10, output: 4 } });
    await sibling.append("session/subagent-usage", { agentId: "sa_1", usage: { input: 7, output: 3 } }); // 旧实现：兄弟循环落穿不计
    await sibling.close();
    // 当前会话（内存镜像态）：自己的子代理账走 sumUsage 路径——两路径共用 usageDelta 后口径钉死
    const cur = new JsonlSessionStore({ dir, sessionId: "s_cur" });
    await cur.append("session/header", { format: 1 });
    await cur.append("session/subagent-usage", { agentId: "sa_2", usage: { input: 2, output: 1 } });
    expect(await cur.lifetimeUsage()).toEqual({ input: 19, output: 8, sessions: 2 }); // (10+7)+(2) / (4+3)+(1)：兄弟 17/7 + 当前 2/1
    await cur.close();
  });
});

describe("CS-03 单写者锁（2026-09-28 code review）：同 sessionId 双实例并发写——锁互斥 + stale 回收 + close 释放", () => {
  it("① 双实例并发 append：第二实例 reject 且错误指向双开，文件零交织（旧实现：双方从同尾巴读出相同 seq/lastId，重复 seq + 两链交织静默落盘）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs03-"));
    const a = new JsonlSessionStore({ dir, sessionId: "s_lock" });
    await a.append("session/header", { format: 1 }); // 首写抢锁（await = drain 已完成 = 锁确在盘上——确定性面，无时序竞态）
    const b = new JsonlSessionStore({ dir, sessionId: "s_lock" });
    await expect(b.append("user/message", { content: [] })).rejects.toThrow(/另一实例/); // 同进程双实例：锁 pid = 本进程 pid，活着 → 拒
    await expect(b.close()).rejects.toThrow(); // close 诚实拒绝：b 的事件从未落盘（CS-02 语义——不谎报完成）
    await a.append("user/message", { content: [] });
    await a.close();
    const events = readFileSync(join(dir, "s_lock", "agents", "session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.seq)).toEqual([1, 2]); // 撞号零发生、单链完整
  });

  it("② close 释放锁：首实例 close 后第二实例 append 成功、seq 延续", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs03b-"));
    const a = new JsonlSessionStore({ dir, sessionId: "s_rel" });
    await a.append("session/header", { format: 1 });
    await a.append("user/message", { content: [] });
    await a.close();
    expect(existsSync(join(dir, "s_rel", "agents", "session.lock"))).toBe(false); // close 释放
    const b = new JsonlSessionStore({ dir, sessionId: "s_rel" });
    expect(await b.append("x")).toMatchObject({ seq: 3 }); // 释放后第二实例接管
    await b.close();
  });

  it("③ stale 锁回收：持有者 pid 已死（崩溃残留）→ 回收重建、append 成功自愈", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs03c-"));
    const dead = spawnSync(process.execPath, ["-e", ""]); // 同步等它退出——pid 确定已死（确定性面，不依赖时序）
    expect(dead.pid).toBeGreaterThan(0);
    const lockPath = join(dir, "s_stale", "agents", "session.lock");
    mkdirSync(join(dir, "s_stale", "agents"), { recursive: true });
    writeFileSync(lockPath, `${dead.pid}\n`); // 模拟进程崩溃未 close 的锁残留
    const s = new JsonlSessionStore({ dir, sessionId: "s_stale" });
    await s.append("session/header", { format: 1 }); // 不炸——stale 回收（坏锁文件同样按 stale 处理，不许死锁后续打开）
    expect(readFileSync(lockPath, "utf8").startsWith(String(process.pid))).toBe(true); // 锁已易主
    await s.close();
  });

  it("④ 只读第二实例不受锁影响：构造 + all() 照常（锁只在首写抢——树扫描/fork 祖先视图/测试第二实例零变化）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs03d-"));
    const a = new JsonlSessionStore({ dir, sessionId: "s_ro" });
    await a.append("session/header", { format: 1 });
    await a.append("user/message", { content: [{ kind: "text", text: "q" }] });
    const b = new JsonlSessionStore({ dir, sessionId: "s_ro" }); // a 活着、锁在手
    expect((await b.all()).map((e) => e.type)).toEqual(["session/header", "user/message"]); // 读路径零影响
    await b.close(); // 无锁可释——正常 resolve
    await a.close();
  });
});

describe("CS-02 写失败不毒化写队列（2026-09-28 code review）：drain 失败 → append reject 非假成功；盘恢复后队列自愈", () => {
  it("① 目标文件名撞目录：该次 append reject 且错误可见、后续 append 的 drain 照常执行；② 删占位后滞留批 + 新事件全量落盘、seq 链完整、flush/close 恢复 resolve", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs02-"));
    const s = new JsonlSessionStore({ dir, sessionId: "s_heal" });
    const placeholder = join(dir, "s_heal", "agents", "session.jsonl");
    mkdirSync(placeholder, { recursive: true }); // 占位形态跨平台：文件名撞目录（drain 的 openSync/appendFileSync 必失败）
    // ① 失败窗口：两次 append 都 reject——第一次证明不假成功（旧实现 Promise.resolve(event)），
    // 第二次证明队列没被毒化（旧实现 queue 永久 rejected，后续 drain 全跳过、append 照样假成功）
    const errs: string[] = [];
    for (const [type, fields] of [["session/header", { format: 1 }], ["user/message", { content: [] }]] as const) {
      await s.append(type, fields).then(
        () => { throw new Error("append 假成功（CS-02 旧行为）"); },
        (e: unknown) => { errs.push(String((e as Error).message)); },
      );
    }
    expect(errs).toHaveLength(2);
    expect(errs.every((m) => m.length > 0)).toBe(true); // 错误可见：真实 fs 错误带出调用侧，非静默滞留内存
    await expect(s.flush()).rejects.toThrow(); // flush 不谎报完成：buffer 仍有滞留
    // ② 自愈：删掉占位 → 下一次 append 的 drain 原样重试成功，失败批滞留事件一并补写
    rmSync(placeholder, { recursive: true });
    await s.append("turn/start", { model: "m" });
    await s.flush(); // 旧实现：queue 永久 rejected，此步恒抛、文件永不重建
    const events = readFileSync(placeholder, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]); // 滞留批 + 自愈批全量落盘：内存镜像与磁盘归一、链完整
    expect(events.map((e) => e.type)).toEqual(["session/header", "user/message", "turn/start"]);
    expect((await s.all()).map((e) => e.seq)).toEqual([1, 2, 3]);
    await s.close(); // close 恢复 resolve（buffer 已清空）
  });

  it("ensureFile 失败窗口（CS-02 顺修）：agents 路径被文件占位 → append reject；移除后懒建重试成功（旧实现 fileEnsured 先置位，一次失败后永不重试）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs02b-"));
    const s = new JsonlSessionStore({ dir, sessionId: "s_block" });
    mkdirSync(join(dir, "s_block"), { recursive: true });
    const blocker = join(dir, "s_block", "agents");
    writeFileSync(blocker, "x"); // agents 该是目录的位置放文件——ensureFile 的 mkdirSync 抛
    await expect(s.append("session/header", { format: 1 })).rejects.toThrow();
    rmSync(blocker);
    await s.append("user/message", { content: [] }); // 懒建重试：mkdir 重跑、文件建起（旧实现跳过懒建恒 ENOENT）
    const events = readFileSync(join(blocker, "session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    await s.close();
  });
});

describe("CS-11 repairFile 最小写面（2026-09-28 code review）：修复 = 原地截断/追加，不再全文覆写", () => {
  it("① 仅缺尾换行 → 只追加 \"\\n\"，原始字节保真（旧实现 writeFileSync 全文重写——非规范排版的行会被重序列化，覆写中途崩溃丢整段历史）", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs11-"));
    const file = join(dir, "s_a.jsonl");
    // 刻意带空格的非规范 JSON 排版：旧全文覆写会把它重序列化为紧凑形态（字节被改写）
    const original = '{ "v": 1, "id": "e_1", "parentId": null, "seq": 1, "ts": "t", "type": "session/header" }';
    writeFileSync(file, original);
    expect(repairFile(file)).toEqual({ truncated: false, interruptedClosed: false });
    expect(readFileSync(file, "utf8")).toBe(original + "\n"); // 前缀逐字节不动，仅尾部补换行
  });

  it("② torn tail → ftruncate 精确截到坏行起点：好行与空行字节原样保留 + 未闭合 turn 补事件走追加", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs11b-"));
    const file = join(dir, "s_b.jsonl");
    const l1 = '{"v":1,"id":"e1","parentId":null,"seq":1,"ts":"t","type":"session/header"}';
    const l2 = '{"v":1,"id":"e2","parentId":"e1","seq":2,"ts":"t","type":"turn/start"}';
    writeFileSync(file, `${l1}\n\n${l2}\n{"v":1,"id":"e3","ty`); // 中间空行（旧覆写会丢）+ 撕裂尾
    const r = repairFile(file);
    expect(r.truncated).toBe(true);
    expect(r.interruptedClosed).toBe(true); // turn/start 未闭合——补 turn/end
    const after = readFileSync(file, "utf8");
    const prefix = `${l1}\n\n${l2}\n`;
    expect(after.startsWith(prefix)).toBe(true); // 前缀逐字节保真（含空行——旧 good.join("\n") 重排会抹掉）
    const appended = after.slice(prefix.length).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ type: "turn/end", kind: "interrupted" });
  });

  it("③ 未闭合 turn（无撕裂）→ 纯追加补事件，前缀字节不动", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs11c-"));
    const file = join(dir, "s_c.jsonl");
    const l1 = '{"v":1,"id":"e1","parentId":null,"seq":1,"ts":"t","type":"session/header"}';
    const l2 = '{"v":1,"id":"e2","parentId":"e1","seq":2,"ts":"t","type":"turn/start"}';
    writeFileSync(file, `${l1}\n${l2}\n`);
    const r = repairFile(file);
    expect(r.truncated).toBe(false);
    expect(r.interruptedClosed).toBe(true);
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(`${l1}\n${l2}\n`)).toBe(true); // 不截断、不改写——只追加
    expect(after.trim().split("\n")).toHaveLength(3);
  });
});

describe("CS-07 写入硬化补口（2026-09-28 code review）：O_NOFOLLOW 数值旗标 + 重建兜底权限", () => {
  it("sessionAppendFlag：Windows 降级字符串 'a'；POSIX = O_APPEND|O_NOFOLLOW|O_CREAT 数值组合（§6.1 硬化 (b) 承诺——字符串旗标表达不了 O_NOFOLLOW）", () => {
    expect(sessionAppendFlag("win32")).toBe("a");
    const f = sessionAppendFlag("linux");
    expect(typeof f).toBe("number");
    expect((f as number) & constants.O_APPEND).toBe(constants.O_APPEND);
    expect((f as number) & constants.O_CREAT).toBe(constants.O_CREAT);
    if (constants.O_NOFOLLOW !== undefined) { // win32 宿主常量缺 O_NOFOLLOW（=undefined）——POSIX CI 上钉位
      expect((f as number) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    }
    expect(sessionAppendFlag("darwin")).toBe(sessionAppendFlag("linux")); // POSIX 族同组合
  });
});

describe("CS-12 会话 id 格式闸（2026-09-28 code review）：sessionId 直接进路径 join——旧实现 \"../escaped\" 一次 append 即桶外建目录文件", () => {
  it("构造器非法 id 响亮抛错、桶内桶外零创建；真实 id 形态照常通过", () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-cs12-"));
    dir = d;
    for (const bad of ["../escaped-cs12", "a/b", "a\\b", "..", ".", " s", "s\t"]) {
      expect(() => new JsonlSessionStore({ dir: d, sessionId: bad })).toThrow(/会话 id 非法/);
    }
    expect(readdirSync(d)).toEqual([]); // 桶内零残留
    expect(existsSync(join(d, "..", "escaped-cs12"))).toBe(false); // 桶外零逃逸
    expect(() => new JsonlSessionStore({ dir: d, sessionId: "agents_1" })).not.toThrow(); // 子代理目录形态通过
  });
});

describe("CS-14 lifetimeUsage 混合后端桶（2026-09-28 code review）：sqlite 兄弟不再静默漏计", () => {
  it.skipIf(!sqliteAvailable())("sqlite 兄弟按同口径聚合（usageDelta + fork 子体整库跳过）——jsonl 当前会话视角补齐项目累计", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cs14-"));
    const { SqliteSessionStore } = await import("./sqlite.ts");
    // sqlite 根会话（磁盘态）：message 用量 + 子代理账
    const sqRoot = new SqliteSessionStore({ dir, sessionId: "s_sq_root" });
    await sqRoot.append("session/header", { format: 1, cwd: dir, parentSession: null });
    await sqRoot.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage: { input: 10, output: 4 } });
    await sqRoot.append("session/subagent-usage", { agentId: "sa_1", usage: { input: 7, output: 3 } });
    await sqRoot.close();
    // sqlite fork 子体：lineage 以父计——整库跳过（含 sessions 计数）
    const sqKid = new SqliteSessionStore({ dir, sessionId: "s_sq_kid" });
    await sqKid.append("session/header", { format: 1, cwd: dir, parentSession: "s_sq_root" });
    await sqKid.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage: { input: 100, output: 50 } });
    await sqKid.close();
    // jsonl 当前会话：旧实现 filter(.jsonl) 把上面两个 sqlite 会话全漏（/usage 项目累计静默缺斤少两）
    const cur = new JsonlSessionStore({ dir, sessionId: "s_cur" });
    await cur.append("session/header", { format: 1 });
    expect(await cur.lifetimeUsage()).toEqual({ input: 17, output: 7, sessions: 1 }); // sqlite 根 10+7/4+3；sqlite 子体跳过
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

describe("T1 m5-resume-perf: repairFile 与构造镜像合读（构造期一次读盘）", () => {
  it("constructor 读盘恰 1 次——torn tail 修复与镜像装载共用一次读盘，修复动作照旧", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-t1-"));
    const file = join(dir, "s_torn", "agents", "session.jsonl");
    mkdirSync(join(dir, "s_torn", "agents"), { recursive: true });
    const good = [
      JSON.stringify({ v: 1, id: "e_1", parentId: null, seq: 1, ts: "t", type: "session/header" }),
      JSON.stringify({ v: 1, id: "e_2", parentId: "e_1", seq: 2, ts: "t", type: "turn/start" }),
    ].join("\n");
    writeFileSync(file, good + "\n" + '{"v":1,"id":"e_3","typ'); // 撕裂尾部
    vi.mocked(readFileSync).mockClear();
    const s = new JsonlSessionStore({ dir, sessionId: "s_torn" });
    const calls = vi.mocked(readFileSync).mock.calls.filter((c) => c[0] === file);
    expect(calls).toHaveLength(1); // 现状=2：repairFile 一读 + 镜像装载一读
    // torn tail 仍被修复（截断 + 补 turn/end，与现状一致）
    const onDisk = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; type: string });
    expect(onDisk).toHaveLength(3);
    expect(onDisk[2]!.type).toBe("turn/end");
    expect(onDisk[2]!.id).not.toBe("e_1");
    // 镜像与修复后文件一致（含补入的 turn/end——镜像不能缺也不能 parse 炸）
    expect((await s.all()).map((e) => e.id)).toEqual(onDisk.map((e) => e.id));
    await s.close();
  });
});

describe("T3 m5-resume-perf: usage 兄弟聚合 (mtime,size) 缓存", () => {
  it("两次 lifetimeUsage：第二次兄弟文件 0 次读盘且数值一致；变更兄弟后仅重读该文件", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-t3-"));
    const mk = async (sid: string, input: number, output: number): Promise<void> => {
      const s = new JsonlSessionStore({ dir: dir!, sessionId: sid });
      await s.append("session/header", { cwd: dir, parentSession: null });
      await s.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage: { input, output } });
      await s.close();
    };
    await mk("s_a", 10, 4);
    await mk("s_b", 5, 1);
    const cur = new JsonlSessionStore({ dir: dir!, sessionId: "s_cur" });
    await cur.append("session/header", { cwd: dir, parentSession: null });
    const fa = join(dir!, "s_a", "agents", "session.jsonl");
    const fb = join(dir!, "s_b", "agents", "session.jsonl");
    vi.mocked(readFileSync).mockClear();
    const first = await cur.lifetimeUsage();
    expect(first).toEqual({ input: 15, output: 5, sessions: 2 });
    const firstReadsA = vi.mocked(readFileSync).mock.calls.filter((c) => c[0] === fa).length;
    expect(firstReadsA).toBe(1);
    // 第二次：缓存命中——兄弟文件 0 次读盘，数值一致
    vi.mocked(readFileSync).mockClear();
    const second = await cur.lifetimeUsage();
    expect(second).toEqual({ input: 15, output: 5, sessions: 2 });
    expect(vi.mocked(readFileSync).mock.calls.filter((c) => c[0] === fa)).toHaveLength(0);
    expect(vi.mocked(readFileSync).mock.calls.filter((c) => c[0] === fb)).toHaveLength(0);
    // 改写 s_a（append 新用量行 + mtime 强制前移防同毫秒）→ 第三次仅重读 s_a
    appendFileSync(fa, JSON.stringify({ v: 1, id: "e_x", parentId: null, seq: 9, ts: "t", type: "assistant/message", content: [{ kind: "text", text: "答" }], usage: { input: 100, output: 50 } }) + "\n");
    const future = new Date(Date.now() + 5000);
    utimesSync(fa, future, future);
    vi.mocked(readFileSync).mockClear();
    const third = await cur.lifetimeUsage();
    expect(third).toEqual({ input: 115, output: 55, sessions: 2 });
    expect(vi.mocked(readFileSync).mock.calls.filter((c) => c[0] === fa)).toHaveLength(1);
    expect(vi.mocked(readFileSync).mock.calls.filter((c) => c[0] === fb)).toHaveLength(0); // s_b 缓存仍命中
    await cur.close();
  });
});
