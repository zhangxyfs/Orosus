import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagSink, createLogger } from "./logger.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("诊断日志（§11.9）", () => {
  it("CH-04 写盘失败不毒化队列：坏文件后续 write 照排队、flush/close 不再永拒（旧实现 rejected 链静默丢日志 + 崩进程）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-diag-"));
    const sink = createDiagSink({ dir });
    // 当日文件名撞目录 → appendFileSync 必炸（模拟盘满/被锁的持久失败形态）
    mkdirSync(join(dir, `diagnostic-${new Date().toISOString().slice(0, 10)}.jsonl`));
    const log = createLogger(sink, "kernel");
    log.info("t.a", "第一条（失败被吞）");
    log.info("t.b", "第二条（旧实现此条被跳过）");
    await expect(sink.flush()).resolves.toBeUndefined(); // 旧实现：reject
    await expect(sink.close()).resolves.toBeUndefined();
  });
  it("记录带 v/ts/lvl/code/module/msg；写独立 JSONL 文件", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-diag-"));
    const sink = createDiagSink({ dir });
    const log = createLogger(sink, "kernel");
    log.info("kernel.module.active", "模块激活", { name: "tool-fs" });
    await sink.flush();
    const files = readdirSync(dir).filter((f) => f.startsWith("diagnostic-"));
    expect(files).toHaveLength(1);
    const rec = JSON.parse(readFileSync(join(dir, files[0]!), "utf8").trim());
    expect(rec.v).toBe(1);
    expect(rec.lvl).toBe("info");
    expect(rec.code).toBe("kernel.module.active");
    expect(rec.module).toBe("kernel");
    expect(rec.msg).toBe("模块激活");
    expect(rec.data).toEqual({ name: "tool-fs" });
    await sink.close();
  });

  it("data 体积超限被截断并带标记（脱敏与截断纪律）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-diag-"));
    const sink = createDiagSink({ dir });
    const log = createLogger(sink, "loop");
    log.debug("loop.step", "x", { big: "y".repeat(10000) });
    await sink.flush();
    const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim());
    expect(JSON.stringify(rec.data).length).toBeLessThan(3000);
    expect(rec.data._truncated).toBe(true);
    await sink.close();
  });

  it("关联字段 sess/turn/call 可选透传", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-diag-"));
    const sink = createDiagSink({ dir });
    const log = createLogger(sink, "tool").withCtx({ sess: "s_1", turn: "e_9", call: "c_1" });
    log.info("tool.execute", "执行");
    await sink.flush();
    const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim());
    expect(rec.sess).toBe("s_1");
    expect(rec.turn).toBe("e_9");
    expect(rec.call).toBe("c_1");
    await sink.close();
  });
});
