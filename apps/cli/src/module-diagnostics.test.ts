import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiagnostics, renderDetail } from "./module-diagnostics.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = mkdtempSync(join(tmpdir(), "orosus-diag-")); dirs.push(d); return d; };

const line = (over: { ts?: string; code: string; msg: string; data?: Record<string, unknown> }) =>
  JSON.stringify({ v: 1, ts: over.ts ?? "2026-09-25T10:00:00.000Z", lvl: "warn", code: over.code, module: "kernel", msg: over.msg, ...(over.data !== undefined ? { data: over.data } : {}) });

const NOW = new Date("2026-09-25T23:30:00.000Z");

describe("readDiagnostics（T8：弹窗数据源——过滤/聚合/标签/跨天）", () => {
  it("① 过滤：四类事件码进；信息性码不进；skip 良性形态不进、三个失败形态进", () => {
    const d = mk();
    writeFileSync(join(d, "diagnostic-2026-09-25.jsonl"), [
      line({ code: "kernel.module.failed", msg: "模块降级：配置校验失败：x", data: { module: "m1" } }),
      line({ code: "kernel.discover.fail", msg: "模块 m2 加载失败：boom" }),
      line({ code: "kernel.discover.skip", msg: "目录 m3 的包描述读取失败（package.json：xx），跳过", data: { module: "m3" } }),
      line({ code: "kernel.discover.skip", msg: "目录 m4 入口读取失败（index.ts：EISDIR），跳过", data: { module: "m4" } }),
      line({ code: "kernel.discover.skip", msg: "模块 m5（source 目录）无入口，跳过", data: { module: "m5" } }),
      line({ code: "kernel.discover.skip", msg: "目录 readme 无模块入口（无 orosus.module 声明且无 index.{ts,js}），跳过" }), // 良性——不进
      line({ code: "kernel.discover.missing", msg: "模块 m6 的 source 路径不存在：/x" }),
      line({ code: "kernel.config.orphan-section", msg: "配置 section [ghost] 无对应已安装模块" }),
      line({ code: "kernel.reload.done", msg: "reload 完成" }),
      line({ code: "kernel.discover.npm-skip", msg: "模块 n1 的 source 是 npm 说明符" }),
      line({ code: "kernel.discover.name-mismatch", msg: "配置 section [n2] 加载出模块 \"other\"" }),
      line({ code: "host.module.cascade", msg: "联动卸载 tool-fs：连带停用 tool-shell" }),
    ].join("\n") + "\n");
    const got = readDiagnostics(d, NOW);
    expect(got.map((e) => e.name).sort()).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("② 聚合：同模块同原因合并计次、last 取最新；模块名两路来源（data.module 优先 + msg 前缀兜底）", () => {
    const d = mk();
    writeFileSync(join(d, "diagnostic-2026-09-25.jsonl"), [
      line({ ts: "2026-09-25T08:00:00.000Z", code: "kernel.discover.skip", msg: "目录 bad 的包描述读取失败（package.json：e1），跳过" }), // msg 前缀「目录 X」提取
      line({ ts: "2026-09-25T09:00:00.000Z", code: "kernel.discover.skip", msg: "目录 bad 的包描述读取失败（package.json：e1），跳过" }),
      line({ ts: "2026-09-25T12:00:00.000Z", code: "kernel.module.failed", msg: "模块降级：boom", data: { module: "act-mod" } }),
      "{ 这是一行坏 JSON", // 坏行跳过
    ].join("\n") + "\n");
    const got = readDiagnostics(d, NOW);
    const bad = got.find((e) => e.name === "bad")!;
    expect(bad.count).toBe(2);
    expect(bad.last).toBe("2026-09-25T09:00:00.000Z");
    expect(got.find((e) => e.name === "act-mod")!.count).toBe(1);
    expect(got.map((e) => e.name)).toEqual(["act-mod", "bad"]); // last 倒序（12:00 > 09:00）
  });

  it("③ 标签：S4 三分类——discover.* 加载失败；级联三关键词（级联/不可用（/无可用提供者）→ 级联；其余激活失败", () => {
    const d = mk();
    writeFileSync(join(d, "diagnostic-2026-09-25.jsonl"), [
      line({ code: "kernel.module.failed", msg: "模块降级：硬依赖能力 \"fs\" 的提供者 tool-fs 已降级（级联降级）", data: { module: "a" } }),
      line({ code: "kernel.module.failed", msg: "模块降级：硬依赖能力 \"fs\" 的提供者 tool-fs 不可用（tool-fs 已降级）", data: { module: "b" } }),
      line({ code: "kernel.module.failed", msg: "模块降级：硬依赖能力 \"fs\" 无可用提供者（未安装/未声明）", data: { module: "c" } }),
      line({ code: "kernel.module.failed", msg: "模块降级：硬依赖能力 \"x\" 未注册：其提供者已激活但未 provide（提供者模块 bug）", data: { module: "d" } }), // 含「提供者」但非三关键词 → 激活失败
      line({ code: "kernel.module.failed", msg: "模块降级：配置校验失败：mode 越界", data: { module: "e" } }),
      line({ code: "kernel.discover.fail", msg: "模块 f 加载失败：语法错" }),
    ].join("\n") + "\n");
    const got = readDiagnostics(d, NOW);
    const tagOf = (n: string) => got.find((e) => e.name === n)!.tag;
    expect(tagOf("a")).toBe("级联");
    expect(tagOf("b")).toBe("级联");
    expect(tagOf("c")).toBe("级联");
    expect(tagOf("d")).toBe("激活失败"); // bug 分支正确排除（S4 一轮校正点）
    expect(tagOf("e")).toBe("激活失败");
    expect(tagOf("f")).toBe("加载失败");
  });

  it("④ 跨天（S2）：当天文件缺失、前一天文件有记录 → 能读到（UTC 日期同式计算）", () => {
    const d = mk();
    writeFileSync(join(d, "diagnostic-2026-09-24.jsonl"), line({ ts: "2026-09-24T23:00:00.000Z", code: "kernel.module.failed", msg: "模块降级：昨天的失败", data: { module: "yest" } }) + "\n");
    const got = readDiagnostics(d, NOW); // NOW = 09-25T23:30Z：当天文件不存在
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe("yest");
    expect(got[0]!.reason).toContain("昨天的失败");
  });
});

describe("renderDetail（T10/S9：二级详情拼装——四节/时间线排序/连带点名）", () => {
  const ev = (ts: string, msg: string, module: string): { ts: string; code: string; msg: string; data: Record<string, unknown> } =>
    ({ ts, code: "kernel.module.failed", msg, data: { module } });
  const events = [
    ev("2026-09-25T09:00:40.000Z", "模块降级：晚发生", "tool-fs"),
    ev("2026-09-25T08:59:56.000Z", "模块降级：早发生", "tool-fs"),
    ev("2026-09-25T09:00:41.000Z", "模块降级：硬依赖能力 \"fs\" 的提供者 tool-fs 已降级（级联降级）", "tool-shell"),
    ev("2026-09-25T09:00:35.000Z", "模块降级：硬依赖能力 \"fs\" 无可用提供者（未安装/未声明）", "tool-shell"),
  ];

  it("⑤ 从犯视角：四节齐、连带节点名提供者、时间线按时间排序", () => {
    const victim: import("./module-diagnostics.ts").DiagEntry = {
      name: "tool-shell", tag: "级联", reason: "模块降级：硬依赖能力 \"fs\" 的提供者 tool-fs 已降级（级联降级）", count: 2, last: "2026-09-25T09:00:41.000Z",
    };
    const text = renderDetail(victim, events);
    expect(text).toContain("【失败原因】");
    expect(text).toContain("【连带影响】");
    expect(text).toContain("tool-fs"); // 从犯原因点名提供者
    expect(text).toContain("【事件时间线】");
    expect(text).toContain("【修复指引】");
    const tl = text.split("【事件时间线】")[1] ?? "";
    expect(tl.indexOf("09:00:35")).toBeLessThan(tl.indexOf("09:00:41")); // 时间线节内按 ts 排序（tool-shell 自己的两条）
    expect(text).toContain("自动恢复"); // 级联模板（S9）
  });

  it("⑥ 主犯视角反查（谁被我拖累）与加载失败模板（未进图说明）", () => {
    const provider: import("./module-diagnostics.ts").DiagEntry = { name: "tool-fs", tag: "激活失败", reason: "模块降级：配置校验失败：mode 越界", count: 1, last: "2026-09-25T09:00:40.000Z" };
    const providerText = renderDetail(provider, events);
    expect(providerText).toContain("连带拖累：tool-shell"); // tool-shell 的事件点名 tool-fs → 主犯反查
    const loader: import("./module-diagnostics.ts").DiagEntry = { name: "my-mod", tag: "加载失败", reason: "模块 my-mod 加载失败：SyntaxError", count: 1, last: "2026-09-25T08:59:56.000Z" };
    const loaderText = renderDetail(loader, []);
    expect(loaderText).toContain("未进图"); // S9：加载失败模板带「未进图、不影响主程序」
    expect(loaderText).not.toContain("【连带影响】"); // 加载失败无连带节
  });
});
