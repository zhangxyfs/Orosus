import { describe, it, expect, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
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
    const lines = readFileSync(join(dir, `${s.sessionId}.jsonl`), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("session/header");
    expect(JSON.parse(lines[1]!).seq).toBe(2);
    await s.close();
  });

  it("POSIX 上文件权限为 0o600；Windows 降级不报错", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-"));
    const s = new JsonlSessionStore({ dir });
    await s.append("x");
    await s.flush();
    if (process.platform !== "win32") {
      expect(statSync(join(dir, `${s.sessionId}.jsonl`)).mode & 0o777).toBe(0o600);
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
});
