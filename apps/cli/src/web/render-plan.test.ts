/** web 批 T16 伴生测试：render.js 纯函数区——planAppend 增量渲染计划 + 事件→行文案推导。
 *  口径：§5 律一（渲染器与 DOM 解耦——`planAppend(renderedSeqs, events) → 操作列表` 纯函数，
 *  node 直测零 DOM）+ brief Steps① 的映射族（tool 行/diff/思考块预览/技能标记/usage 旁注文案源）。
 *  DOM 应用层无 node 可测面（无 jsdom 依赖纪律）——「无整区重渲路径」由代码走查自证（报告留档）。 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import "./assets/render.js"; // 副作用挂 globalThis.OrosusRender（经典脚本零构建——node/浏览器同源导出）
import "./assets/ui.js"; // 同源挂 globalThis.OrosusUI（顶层零 DOM 触碰——node 可载）

/* noUncheckedIndexedAccess 下 Record 索引签名带 undefined——显式接口剥可选层（兼作导出面清单） */
type Fn = (...args: unknown[]) => unknown;
interface RenderApi {
  planAppend: Fn; isGhostTool: Fn; toolDisplayName: Fn; toolKeyArg: Fn; toolHeadText: Fn;
  toolHeadHtml: Fn; toolTailOf: Fn; crWash: Fn; outputLinesOf: Fn; pageSlice: Fn;
  lineCountOf: Fn; diffRowsOf: Fn; changeStatsOf: Fn; resultChip: Fn;
  skillMarkOf: Fn; textOf: Fn; reasoningOf: Fn; imagesOf: Fn; fmtK: Fn; fmtDur: Fn;
  fmtTurnTime: Fn; fmtWorkDur: Fn; esc: Fn;
  mdLinkHook: Fn; ensureMdLinkHook: Fn; /* 走查修（2026-10-15）：链接加固钩子本体与注册口 */
}
const R = (globalThis as { OrosusRender?: RenderApi }).OrosusRender!;
interface UiApi {
  nextRowIdx: (rows: Array<Record<string, unknown>>, from: number, dir: number) => number;
}
const UI = (globalThis as { OrosusUI?: UiApi }).OrosusUI!;
const ASSETS_DIR = fileURLToPath(new URL("./assets/", import.meta.url));

describe("web T16：planAppend 增量渲染计划（律一纯函数核）", () => {
  it("① 空底座顺序追加：ops 全 append、seqs 升序、maxSeq 到位", () => {
    const out = R.planAppend([], [
      { seq: 2, type: "turn/start" },
      { seq: 1, type: "user/message" },
      { seq: 3, type: "assistant/message" },
    ]) as { ops: { op: string; seq: number }[]; seqs: number[]; maxSeq: number };
    expect(out.ops.map((o) => o.op)).toEqual(["append", "append", "append"]);
    expect(out.ops.map((o) => o.seq)).toEqual([1, 2, 3]); // 乱序批先排序
    expect(out.seqs).toEqual([1, 2, 3]);
    expect(out.maxSeq).toBe(3);
  });

  it("② 已渲染 seq 重复到达（SSE backfill 重叠）——天然去重跳过", () => {
    const out = R.planAppend([1, 2, 3], [{ seq: 3, type: "turn/end" }, { seq: 4, type: "user/message" }]) as {
      ops: { op: string; seq: number }[];
      seqs: number[];
    };
    expect(out.ops).toHaveLength(1);
    expect(out.ops[0]!.op).toBe("append");
    expect(out.ops[0]!.seq).toBe(4);
    expect(out.seqs).toEqual([1, 2, 3, 4]);
  });

  it("③ 断线 backfill 按 seq 补插：beforeSeq = 最小的更大已渲染 seq（不重排已渲染区）", () => {
    const out = R.planAppend([10, 11], [{ seq: 9, type: "user/message" }, { seq: 8, type: "turn/end" }]) as {
      ops: { op: string; seq: number; beforeSeq?: number }[];
      seqs: number[];
    };
    expect(out.ops.map((o) => o.op)).toEqual(["insert", "insert"]);
    expect(out.ops.map((o) => o.seq)).toEqual([8, 9]);
    expect(out.ops.every((o) => o.beforeSeq === 10)).toBe(true);
    expect(out.seqs).toEqual([8, 9, 10, 11]);
  });

  it("④ 混合批（backfill 旧页 + live 新尾同批）：insert 在前 append 在后、seqs 全序", () => {
    const out = R.planAppend([10], [{ seq: 15, type: "assistant/message" }, { seq: 3, type: "user/message" }]) as {
      ops: { op: string; seq: number; beforeSeq?: number }[];
      seqs: number[];
    };
    expect(out.ops.map((o) => o.op)).toEqual(["insert", "append"]);
    expect(out.ops[0]).toMatchObject({ seq: 3, beforeSeq: 10 });
    expect(out.ops[1]!.seq).toBe(15);
    expect(out.seqs).toEqual([3, 10, 15]);
  });

  it("⑤ 纯函数纪律：入参 renderedSeqs/events 均不被改动；空事件批 → 零 ops", () => {
    const rendered = [5, 6];
    const events = [{ seq: 4, type: "turn/end" }, { seq: 7, type: "user/message" }];
    const out = R.planAppend(rendered, events) as { ops: unknown[]; seqs: number[] };
    expect(rendered).toEqual([5, 6]);
    expect(events).toHaveLength(2);
    expect(out.seqs).toEqual([4, 5, 6, 7]);
    const empty = R.planAppend([1, 2], []) as { ops: unknown[]; seqs: number[] };
    expect(empty.ops).toEqual([]);
    expect(empty.seqs).toEqual([1, 2]);
    const junk = R.planAppend([1], [null, undefined, {}, { type: "x" }]) as { ops: unknown[]; seqs: number[] };
    expect(junk.ops).toEqual([]); // 无 seq 字段的脏数据被滤除
  });

  it("⑥ 2000 事件长会话计划性能：全量追加一次计划 < 500ms 且 ops 计数精确（性能验收①的纯函数面）", () => {
    const events = Array.from({ length: 2000 }, (_, i) => ({ seq: i + 1, type: i % 4 === 0 ? "user/message" : "assistant/message" }));
    const t0 = Date.now();
    const out = R.planAppend([], events) as { ops: unknown[]; seqs: number[]; maxSeq: number };
    const ms = Date.now() - t0;
    expect(out.ops).toHaveLength(2000);
    expect(out.seqs).toHaveLength(2000);
    expect(out.maxSeq).toBe(2000);
    expect(ms).toBeLessThan(500);
  });
});

describe("web T16：事件 → 行文案映射族（纯推导）", () => {
  it("⑦ 幽灵工具与显示名：tasks 纯查询双侧静默；模块前缀剥离 + 首字母大写", () => {
    expect(R.isGhostTool("tool-subagent__tasks")).toBe(true);
    expect(R.isGhostTool("tool-fs__read")).toBe(false);
    expect(R.toolDisplayName("tool-fs__read")).toBe("Read");
    expect(R.toolDisplayName("tool-shell__bash")).toBe("Bash");
    expect(R.toolDisplayName("WebFetch")).toBe("WebFetch");
  });

  it("⑧ 关键参数：path 在 cwd 内相对化、URL 不相对化、command 折叠空白 + 60 字帽", () => {
    const cwd = "D:\\develop\\Orosus";
    expect(R.toolKeyArg({ path: "D:\\develop\\Orosus\\packages\\core\\src\\harness.ts" }, cwd)).toBe("packages/core/src/harness.ts");
    expect(R.toolKeyArg({ path: "C:\\elsewhere\\x.ts" }, cwd)).toBe("C:\\elsewhere\\x.ts");
    expect(R.toolKeyArg({ url: "https://docs.orosus.dev/harness" }, cwd)).toBe("https://docs.orosus.dev/harness");
    const longCmd = "npm " + "run ".repeat(30) + "build";
    expect((R.toolKeyArg({ command: longCmd }, cwd) as string).length).toBeLessThanOrEqual(60);
    expect(R.toolKeyArg({ pattern: "planAppend" }, "")).toBe("planAppend");
    expect(R.toolKeyArg(undefined, "")).toBe("");
  });

  it("⑨ 工具行头 + chip：Using→Used 形态与「 · N 行」段（C6）", () => {
    const args = { path: "D:\\develop\\Orosus\\a.ts" };
    expect(R.toolHeadText("tool-fs__read", args, "D:\\develop\\Orosus", false)).toBe("● Using Read(a.ts)");
    expect(R.toolHeadText("tool-fs__read", args, "D:\\develop\\Orosus", true, "214 行")).toBe("● Used Read(a.ts) · 214 行");
    expect(R.lineCountOf("l1\n\nl2\nl3\n\n")).toBe(3); // 空行不计
  });

  it("⑩ diff 行（C5）：write 全量增行去尾空段；edit 上下文 3 行 + 增删行 + gap 隔断", () => {
    const w = R.diffRowsOf("tool-fs__write", { path: "a.ts", content: "a\nb\n\n\n" }) as { tag: string; no: number; text: string }[];
    expect(w.map((r) => r.tag)).toEqual(["add", "add"]);
    expect(w[1]).toMatchObject({ no: 2, text: "b" });
    const oldText = Array.from({ length: 10 }, (_, i) => "old" + i).join("\n");
    const newText = Array.from({ length: 10 }, (_, i) => (i === 5 ? "new5" : "old" + i)).join("\n");
    const e = R.diffRowsOf("tool-fs__edit", { path: "a.ts", edits: [{ oldText, newText }] }) as { tag: string; no: number }[];
    const tags = e.map((r) => r.tag);
    expect(tags[0]).toBe("gap"); // 前缀 >3 行 → gap 隔断
    expect(tags.filter((t) => t === "ctx")).toHaveLength(6); // 前后各 3 行上下文
    expect(tags.filter((t) => t === "del")).toHaveLength(1);
    expect(tags.filter((t) => t === "add")).toHaveLength(1);
    expect(R.diffRowsOf("tool-shell__bash", { command: "ls" })).toBeNull(); // 非 edit/write 无 diff
    expect(R.diffRowsOf("tool-fs__write", { content: "" })).toBeNull(); // 空内容
  });

  it("⑪ 变更统计与结果 chip：edit +A -D / write N 行 / 失败 / 拒绝 / 截断 / 附件（usage 旁注同源的 chip 面）", () => {
    expect(R.changeStatsOf("tool-fs__write", { content: "a\nb\nc" })).toEqual({ adds: 3, dels: 0, lines: 3 });
    const st = R.changeStatsOf("tool-fs__edit", { edits: [{ oldText: "a\nb\nc\nd\ne", newText: "a\nx\nc\nd\ne" }] }) as { adds: number; dels: number };
    expect(st).toMatchObject({ adds: 1, dels: 1 });
    expect(R.resultChip({ output: "l1\nl2", name: "tool-fs__read", args: {} })).toBe("2 行");
    expect(R.resultChip({ output: "", name: "tool-fs__edit", args: { edits: [{ oldText: "a\nb", newText: "x\ny\nz" }] } })).toBe("+3 -2"); // toolview 同口径：pre/suf=0 → del 2 add 3
    expect(R.resultChip({ output: "x", name: "tool-fs__write", args: { content: "a\nb" }, truncated: true, images: [{ path: "p" }] })).toBe("2 行 · 截断 · 1 附件");
    expect(R.resultChip({ isError: true, output: "boom", name: "t", args: {} })).toBe("失败");
    expect(R.resultChip({ denied: true, output: "", name: "t", args: {} })).toBe("已拒绝");
  });

  it("⑫ 思考块收起零内容行（2026-10-12 走查五轮口令：只留标题行——尾行预览亦不显；全文只在展开时进 DOM〔§5 律二〕）", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf-8");
    expect(src).toMatch(/bodyEl\.textContent = collapsed \? '' : t\.fullText;/); // 折叠空体（源锚——DOM 应用层无 node 直测面）
    expect(src).not.toMatch(/thinkPreviewOf/); // 预览函数整体退役（定义/调用/导出三处全清）
    expect(readFileSync(join(ASSETS_DIR, "style.css"), "utf-8")).toMatch(/\.think\.collapsed \.think-body \{ display: none; \}/); // 收起即不占行
  });

  it("⑬ 技能加载标记行检测（C9）：SKILL_MARK 前缀 → 名；普通文本 → null", () => {
    expect(R.skillMarkOf('（用户通过菜单手动加载技能 "tdd"——请按该技能正文行事）\n\n# TDD 技能正文…')).toBe("tdd");
    expect(R.skillMarkOf("普通消息")).toBeNull();
    expect(R.skillMarkOf("")).toBeNull();
  });

  it("⑭ content 块拆解：text 拼接 / reasoning 拼接 / image 路径列表（C3 图注面）", () => {
    const ev = {
      content: [
        { kind: "reasoning", text: "想一" },
        { kind: "text", text: "正" },
        { kind: "image", path: "b/s/media/web-x.png", mimeType: "image/png" },
        { kind: "text", text: "文" },
      ],
    };
    expect(R.textOf(ev)).toBe("正文");
    expect(R.reasoningOf(ev)).toBe("想一");
    expect(R.imagesOf(ev)).toEqual([{ kind: "image", path: "b/s/media/web-x.png", mimeType: "image/png" }]);
    expect(R.textOf({})).toBe("");
  });

  it("⑮ 数字与时间格式：fmtK 千位压缩 / fmtDur 持续时长 / fmtTurnTime 今天-昨天-日期三态", () => {
    expect(R.fmtK(900)).toBe("900");
    expect(R.fmtK(1200)).toBe("1.2k");
    expect(R.fmtK(12345)).toBe("12k");
    expect(R.fmtDur(168000)).toBe("持续了 168 秒"); // <5 分钟直显秒（原型「持续了 168 秒」同式）
    expect(R.fmtDur(90000)).toBe("持续了 90 秒");
    expect(R.fmtDur(360000)).toBe("持续了 6 分 0 秒");
    expect(R.fmtDur(undefined)).toBe("");
    const now = new Date("2026-10-11T10:00:00").getTime();
    expect(R.fmtTurnTime("2026-10-11T09:05:00Z", now)).toMatch(/^今天 \d{2}:\d{2}$/); // 本地时区任意——形态断言
    expect(R.fmtTurnTime("2026-10-10T09:05:00Z", now)).toMatch(/^(昨天|\d+月\d+日) \d{2}:\d{2}$/);
    expect(R.fmtTurnTime("not-a-date", now)).toBe("");
  });

  it("⑯ esc 全量转义（五字符——api.js 同源口径）", () => {
    expect(R.esc('a<b>&"c\'')).toBe("a&lt;b&gt;&amp;&quot;c&#39;");
  });
});

describe("web W3（问题 2）：/tasks 改造 + 主流行 open-or-switch 路由", () => {
  it("W3a render.js：spawn 组卡 sg-row 点击路由保持 R.onAgentOpen 回调（app.js 侧改接 OrosusPane）+ data-agent-id 钩子 + v2 分栏 title 提示", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf8");
    const zone = src.slice(src.indexOf("function spawnResultInto"), src.indexOf("function emitToolCall"));
    expect(zone).toContain("row.setAttribute('data-agent-id', id)");
    expect(zone).toContain("R.onAgentOpen(aid)"); // 点击回调机制不变——路由目标在 app.js 接线处改 OrosusPane
    expect(zone).toContain("row.title ="); // v2 1195：「点击在右侧分栏查看该子代理（已开则切换，不重复开）」
    expect(zone).toContain("右侧分栏查看");
    expect(zone).not.toContain("回放窗"); // 旧「进回放窗」口径绝迹（v2 交互契约：分栏 open-or-switch）
  });

  it("W3b app.js：onAgentOpen 接线改 openAgentTab（OrosusPane agent open-or-switch）——ui.openSubagent 面绝迹", () => {
    const src = readFileSync(join(ASSETS_DIR, "app.js"), "utf8");
    expect(/onAgentOpen:\s*function\s*\(id\)\s*\{\s*openAgentTab\(id\);\s*\}/.test(src), "onAgentOpen → openAgentTab 接线").toBe(true);
    expect(src).not.toContain("UI.openSubagent"); // 旧回放窗直进口拆除
  });

  it("W3c app.js：handleMark 无 tasks 分支（走查修① 用户口令 2026-10-13：/tasks 入口下线——cmdTasks 一并删除）", () => {
    const src = readFileSync(join(ASSETS_DIR, "app.js"), "utf8");
    const zone = src.slice(src.indexOf("function handleMark"), src.indexOf("贴图（D6"));
    expect(zone.includes("cmdTasks"), "cmdTasks 已随 /tasks 入口下线").toBe(false);
    expect(zone.includes("'tasks'"), "handleMark 无 tasks 分支").toBe(false);
    expect(zone).not.toContain("openTasksPanel");
  });
});

describe("web T16：静态资产接线", () => {
  it("⑰ index.html 引入 render.js/ui.js 且序在 app.js 之前；流式期零 markdown 断言（律二源码面）", () => {
    const html = readFileSync(join(ASSETS_DIR, "index.html"), "utf-8");
    const iRender = html.indexOf("/assets/render.js");
    const iUi = html.indexOf("/assets/ui.js");
    const iApp = html.indexOf("/assets/app.js");
    expect(iRender).toBeGreaterThan(0);
    expect(iUi).toBeGreaterThan(0);
    expect(iApp).toBeGreaterThan(iRender);
    expect(iApp).toBeGreaterThan(iUi);
    expect(existsSync(join(ASSETS_DIR, "render.js"))).toBe(true);
    expect(existsSync(join(ASSETS_DIR, "ui.js"))).toBe(true);
    /* 律二硬断言：chunk 流式路径（chunk/flushChunk）不触 marked/DOMPurify——mdRender 仅在
     * assistant/message 转正路径（emitAssistant）被调 */
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf-8");
    const chunkFn = src.slice(src.indexOf("function chunk("), src.indexOf("function finalizeLive"));
    expect(chunkFn).not.toContain("mdRender");
    expect(chunkFn).not.toContain("marked");
    /* 律一硬断言：stream.innerHTML 从不被整体赋值（reset 清空走子节点 remove） */
    expect(src).not.toMatch(/stream\.innerHTML\s*=/);
  });
});

describe("web T16 审查修复（Critical-1 + Important-2/3/4/5）", () => {
  it("R1 键盘导航纯函数 nextRowIdx：全分隔行/空表 → -1 不死循环（@ 零匹配·tasks 空名册按 ↑↓ 不再冻结整页）", () => {
    const sepRows = [{ sep: true }, { sep: true }, { sep: true }] as Array<Record<string, unknown>>;
    expect(UI.nextRowIdx(sepRows, 0, 1)).toBe(-1);
    expect(UI.nextRowIdx(sepRows, 2, -1)).toBe(-1);
    expect(UI.nextRowIdx(sepRows, 1, 1)).toBe(-1);
    expect(UI.nextRowIdx([], 0, 1)).toBe(-1);
    const rows = [{ html: "a" }, { sep: true }, { html: "c" }] as Array<Record<string, unknown>>;
    expect(UI.nextRowIdx(rows, 0, 1)).toBe(2); // 正向跳过 sep
    expect(UI.nextRowIdx(rows, 2, 1)).toBe(0); // 正向环回
    expect(UI.nextRowIdx(rows, 2, -1)).toBe(0); // 反向跳过 sep
    expect(UI.nextRowIdx(rows, 0, -1)).toBe(2); // 反向环回
    const single = [{ html: "only" }] as Array<Record<string, unknown>>;
    expect(UI.nextRowIdx(single, 0, 1)).toBe(0); // 唯一可选行回到自身
    expect(UI.nextRowIdx(single, 0, -1)).toBe(0);
  });

  it("R2 贴图预览不再用 blob:（CSP img-src 'self' data: 吞裂图）——上传落盘后走 /api/media 源", () => {
    const src = readFileSync(join(ASSETS_DIR, "app.js"), "utf8");
    const composerZone = src.slice(src.indexOf("贴图（D6"), src.indexOf("── 队列条"));
    expect(composerZone).not.toContain("createObjectURL"); // 导出下载（a.href）面不受影响——只钉贴图段
    expect(composerZone).not.toContain("revokeObjectURL");
    expect(composerZone).toContain("/api/media?path="); // 预览源 = 落盘路径（Important-2 采用评审建议案）
  });

  it("R3 mid-turn 收容：placeIn 无开口容器必补建 turn（源码结构锚定）+ 恒假条件死代码已删（Important-3/4）", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf8");
    const placeInFn = src.slice(src.indexOf("function placeIn("), src.indexOf("function liveCtx("));
    expect(placeInFn).toContain("ensureTurn(ctx)"); // turn 作用域事件不再散落顶级——复制作用域闭合
    expect(src).not.toContain("anchorEl.parentElement !== R.stream"); // 恒假分支（resolveAnchor 必上爬）已删
  });

  it("R4 itemRowHtml 转义（源码锚定）：pi-name/pi-desc/right 注入前 esc——审批卡 items 原文不可注伪造标记", () => {
    const src = readFileSync(join(ASSETS_DIR, "ui.js"), "utf8");
    const fn = src.slice(src.indexOf("function itemRowHtml("), src.indexOf("/* 通用渲染"));
    expect(fn).toContain("esc(parts.title)");
    expect(fn).toContain("esc(parts.desc)");
    expect(fn).toContain("esc(opts.desc)");
    expect(fn).toContain("esc(opts.right)");
    expect(fn).not.toMatch(/\+\s*parts\.(title|desc)\s*\+/); // 裸拼接绝迹
    expect(fn).not.toMatch(/\+\s*opts\.(desc|right)\s*\+/);
  });
});

describe("web 走查修复（2026-10-12 用户口令轮）：工具行分段配色 + 面板分页纯函数", () => {
  it("W1 toolHeadHtml 分段配色：tverb/tname/targs 三段 + 逐段 esc + ● 归 tchar 不重复", () => {
    const html = R.toolHeadHtml("tool-shell__bash", { command: 'ls "<x>"' }, "", true, "22 行") as string;
    expect(html).toContain('<span class="tverb">Used</span>'); // 动词段——主文本色（浅黑/深白）
    expect(html).toContain('<span class="tname">Bash</span>'); // 工具名段——#7cc9a5
    expect(html).toContain('<span class="targs">(ls &quot;&lt;x&gt;&quot;)</span>'); // 参数段——#97a49a + esc
    expect(html).toContain('<span class="targs"> · 22 行</span>'); // chip 后缀同段色
    expect(html).not.toContain("●"); // ● 归 tchar 段——行头不再重复（旧拼接收窄前为 ●●）
    // 空参数/无 chip 形态
    expect(R.toolHeadHtml("tool-fs__read", {}, "", false)).toBe(
      '<span class="tverb">Using</span> <span class="tname">Read</span>',
    );
    // 文案面与 toolHeadText 同源（同一 toolKeyArg/toolDisplayName 推导）——文本内容等价
    const text = (R.toolHeadHtml("tool-fs__read", { path: "a.ts" }, "", true, "3 行") as string).replace(/<[^>]+>/g, "");
    expect(text).toBe("Used Read(a.ts) · 3 行");
  });

  it("W2 pageSlice 分页切片：页数/收拢/边界（面板模块与连接列表共用）", () => {
    expect(R.pageSlice(13, 0, 6)).toEqual({ page: 0, pages: 3, from: 0, to: 6 });
    expect(R.pageSlice(13, 2, 6)).toEqual({ page: 2, pages: 3, from: 12, to: 13 }); // 尾页短页
    expect(R.pageSlice(13, 9, 6)).toEqual({ page: 2, pages: 3, from: 12, to: 13 }); // 越界收拢
    expect(R.pageSlice(0, 0, 6)).toEqual({ page: 0, pages: 1, from: 0, to: 0 }); // 空表一页
    expect(R.pageSlice(5, 0, 0)).toEqual({ page: 0, pages: 5, from: 0, to: 1 }); // pageSize 0 兜底为 1
  });
});

describe("web 走查修（2026-10-12 第二轮）：工具行收起零预览 + 展开体分形", () => {
  it("T1 toolTailOf 尾名剥离（展开体形态分派键）+ crWash CR 行内取尾（bash 进度条不堆行——调研 §2.6 口径）", () => {
    expect(R.toolTailOf("tool-shell__bash")).toBe("bash");
    expect(R.toolTailOf("tool-fs__read")).toBe("read");
    expect(R.toolTailOf("mcp__ctx7__query")).toBe("query");
    expect(R.toolTailOf("WebFetch")).toBe("WebFetch");
    expect(R.crWash("download 10%\rdownload 99%\rdone  ")).toBe("done");
    expect(R.crWash("no-cr")).toBe("no-cr");
  });

  it("T2 outputLinesOf：CR 清洗 + 尾空行剥除（展开体行源统一口）", () => {
    expect(R.outputLinesOf("a\nb\rc\n\n\n")).toEqual(["a", "c"]);
    expect(R.outputLinesOf("")).toEqual([]);
    expect(R.outputLinesOf("\n\n")).toEqual([]);
  });

  it("T3 源码锚定：emitToolCall 不再直插 diff 预览；patchToolRow 不再插 ⎿ 子行/out-fold——收起态零预览", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf8");
    const callFn = src.slice(src.indexOf("function emitToolCall("), src.indexOf("/* ── 工具体构建"));
    expect(callFn).not.toContain("buildDiffBlock"); // diff 归展开体（懒构建）
    expect(callFn).toContain("tool-body"); // 展开体容器随行创建
    // 向下展开（走查二轮口令）：工具行点击不锚定尾随元素（被点行不动），越出视口顺滚最小量
    expect(callFn).toContain("revealBelow(body)");
    expect(callFn).not.toContain("anchoredToggle");
    const patchFn = src.slice(src.indexOf("function patchToolRow("), src.indexOf("function firstLineOf("));
    expect(patchFn).not.toContain("out-fold");
    expect(patchFn).not.toContain("sub-line");
    expect(patchFn).toContain("fillToolBody"); // 展开中 → 原位重装不收拢
    // 展开体分形齐全（bash 终端回放 / read 行号内容 / edit·write diff / 其余输出块）
    expect(src).toContain("function buildTermBody(");
    expect(src).toContain("function buildFileBody(");
    expect(src).toContain("function buildDiffBody(");
    expect(src).toContain("function buildOutBody(");
    expect(src).toContain("function buildLineFold("); // 超长输出头尾截断（调研 §5-5）
  });

  it("T5 源码锚定（走查二轮）：工具体 10 行高帽 + 体内滚动；浅色主题流区 #F8F8F8 + 终端块白底", () => {
    const css = readFileSync(join(ASSETS_DIR, "style.css"), "utf8");
    expect(css).toContain(".tool-body .term { max-height: calc(10 * 1.75em + 16px); overflow-y: auto; }"); // 10 行高帽（term 自身内衬）
    expect(css).toContain(".tool-body .tb-file, .tool-body .tb-out, .tool-body .tb-diffwrap { max-height: calc(10 * 1.75em); overflow-y: auto; }");
    expect(css).toContain("body.light .stream { background: #f8f8f8; }");
    expect(css).toContain("body.light .term { background: #ffffff;");
  });

  it("T4 源码锚定：回到底部浮钮（调研 §5-1 P1）——open 装配 toBottom + 滚动/流式/摄入三面同步显隐", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf8");
    expect(src).toContain("toBottom: opts.toBottom || null");
    expect(src).toContain("function syncToBottom()");
    const scrollFn = src.slice(src.indexOf("stream.addEventListener('scroll'"), src.indexOf("pgMore.addEventListener"));
    expect(scrollFn).toContain("syncToBottom()");
  });
});

describe("web 走查修（2026-10-13 用户口令）：复制口径 = 正文 markdown 源串、思考不入", () => {
  it("C1 源码锚定：emitAssistant 把 textOf 源串挂上 agent-md.mdSource", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf8");
    const emitFn = src.slice(src.indexOf("function emitAssistant("), src.indexOf("/** 思考块（C4）"));
    expect(emitFn).toContain("md.mdSource = text;"); // 正文 markdown 源串随块存（渲染态 textContent 丢围栏/标记）
  });

  it("C2 纯函数面：textOf/reasoningOf 分源——mdSource 所存的 text 天然不含思考", () => {
    const ev = {
      content: [
        { kind: "reasoning", text: "先想想……" },
        { kind: "text", text: "# 结论\n\n**加粗** 与 `代码`" },
      ],
    };
    expect(R.textOf(ev)).toBe("# 结论\n\n**加粗** 与 `代码`"); // markdown 标记原样保留
    expect(R.textOf(ev)).not.toContain("先想想"); // 思考永不混入正文源串
    expect(R.reasoningOf(ev)).toBe("先想想……");
  });
});

describe("web 工作组（2026-10-13 设计）：fmtWorkDur 时长格式化（ZCode workDuration 同款）", () => {
  it("G1 秒取整至少 1 秒；非零段最多两段；中文数字单位间一空格", () => {
    expect(R.fmtWorkDur(0)).toBe("1 秒"); // 至少 1 秒（0ms 可读性兜底）
    expect(R.fmtWorkDur(400)).toBe("1 秒");
    expect(R.fmtWorkDur(1500)).toBe("2 秒"); // 向最近取整
    expect(R.fmtWorkDur(59_000)).toBe("59 秒");
    expect(R.fmtWorkDur(60_000)).toBe("1 分"); // 零秒段省略
    expect(R.fmtWorkDur(483_000)).toBe("8 分 3 秒");
    expect(R.fmtWorkDur(3_780_000)).toBe("1 小时 3 分"); // 最多两段——秒不写
    expect(R.fmtWorkDur(3_600_000)).toBe("1 小时");
    expect(R.fmtWorkDur(183_600_000)).toBe("2 天 3 小时");
  });
});

describe("web 工作组（2026-10-13 设计）：组骨架与投口", () => {
  it("G2 源码锚定：轮内行统一投组（placeIn/chunk/thinkChunk 三投口）+ 组头文案 + 回放窗豁免", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf8");
    expect(src).toContain("function ensureWork(");
    expect(src).toContain("function workBodyOf(");
    const placeFn = src.slice(src.indexOf("function placeIn("), src.indexOf("function liveCtx("));
    expect(placeFn).toContain("workBodyOf(ctx.turn)"); // 轮内行改投组体
    expect(placeFn).toContain("ctx.noWork"); // 回放窗豁免（timeline 原样陈列）
    const chunkFn = src.slice(src.indexOf("function chunk("), src.indexOf("function flushChunk("));
    expect(chunkFn).toContain("workBodyOf(t)"); // 流式正文行入组
    const thinkFn = src.slice(src.indexOf("function thinkChunk("), src.indexOf("function finalizeLive("));
    expect(thinkFn).toContain("workBodyOf(t)"); // 流式思考块入组
    expect(src).toContain("'工作中'"); // 组头文案前两枚（spec §3.3 逐字）——本任务落地
    expect(src).toContain("'已处理'"); // 「已工作 」/「已停止」由 T3 结算接线引入（G4 断言——2026-10-13 审查修：T2 源码尚无该两字面量）
    const startFn = src.slice(src.indexOf("function emitTurnStart("), src.indexOf("function emitTurnEnd("));
    expect(startFn).toContain("turnStartTs"); // 轮始 ts 落元素（结算时长数据源）
    expect(startFn).toContain("workHeadTick"); // 工作中走字
    expect(startFn).toContain("ctx.fragMode"); // 历史孤儿段出生即「已处理」收起
    const renderFn = src.slice(src.indexOf("function workHeadRender("), src.indexOf("function collapseAnchored("));
    expect(renderFn.indexOf("esc(label)")).toBeLessThan(renderFn.indexOf("tcaret")); // 箭头在文案后（2026-10-13 口令——ZCode「已工作 N ›」形）；collapsible=false 时零 caret（工作中无箭头）
  });

  it("G3 CSS 锚定：组头无下边框（2026-10-13 用户口令——横线无必要）+ 收起态隐藏组体（明暗主题变量复用）", () => {
    const css = readFileSync(join(ASSETS_DIR, "style.css"), "utf8");
    expect(css).toContain(".work-head {");
    const headRules = css.slice(css.indexOf(".work-head {"), css.indexOf(".work-head .tcaret"));
    expect(headRules).not.toContain("border-bottom"); // 组头下不画横线（口令去除——防回流钉）
    expect(css).toContain(".work.collapsed .work-body { display: none; }");
  });

  it("G3b 顶部仅时间显暖黄；底部 busy 尾行只留 spinner，不再重复工作中与秒表", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf8");
    const headFn = src.slice(src.indexOf("function workHeadRender("), src.indexOf("function collapseAnchored("));
    expect(headFn).toContain("duration === undefined");
    expect(headFn).toContain('class="doing"');
    const tickFn = src.slice(src.indexOf("function workHeadTick("), src.indexOf("function workHeadStop("));
    expect(tickFn).toContain("workHeadRender(w, '工作中', false, false, fmtWorkDur(");
    const tailFn = src.slice(src.indexOf("function syncTail("), src.indexOf("/* ── 装配 / 重置"));
    expect(tailFn).toContain("t.innerHTML = spinSvg('', 12);");
    expect(tailFn).not.toContain("tail-time");
    expect(tailFn).not.toContain("busyStart");
    expect(src).not.toContain("R.busyTimer");
    const css = readFileSync(join(ASSETS_DIR, "style.css"), "utf8");
    expect(css).toContain(".doing { color: var(--warn); }");
  });
});

describe("web 工作组（2026-10-13 设计）：结算序列", () => {
  it("G4 源码锚定：emitTurnEnd 结算四步（停表→挪正文→换头→收起）+ straddle 回溯认领 + 翻页重估", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf8");
    const endFn = src.slice(src.indexOf("function emitTurnEnd("), src.indexOf("/* ── 流式 chunk"));
    expect(endFn).toContain("workSettled = true"); // 结算旗标（翻页重估的入场券）
    expect(endFn).toContain("workLabel"); // 三态文案定值
    expect(src).toContain("'已工作 '"); // 组头文案族后两枚随本任务结算接线落地（spec §3.3 逐字）
    expect(src).toContain("'已停止'");
    expect(endFn).toContain("evalTurn(t)");
    expect(endFn.indexOf("evalTurn(t)")).toBeLessThan(endFn.indexOf('data-tf="copy"')); // 结算先于挂 foot（正文落 foot 之上）
    const evalFn = src.slice(src.indexOf("function evalTurn("), src.indexOf("function reevalSettledTurns("));
    expect(evalFn).toContain("groupMdLastOf(t) || claimBackward(t)"); // 组内最后正文，缺则跨段认领（结果必可见）
    expect(evalFn).toContain("insertBefore(md,"); // 挪出组外
    expect(evalFn).toContain("w.remove()"); // 零内容轮整组摘除（ZCode hasWork 同口径）
    const claimFn = src.slice(src.indexOf("function claimBackward("), src.indexOf("function evalTurn("));
    expect(claimFn).toContain(".turn-foot"); // 回溯止于有 foot 的段（不偷正常轮的中间正文）
    const insertFn = src.slice(src.indexOf("function applyInsertGroup("), src.indexOf("function resolveAnchor("));
    expect(insertFn).toContain("reevalSettledTurns()"); // applyInsertGroup 后重估（钉调用点——定义行自含弱化修复）
    expect(src).toContain("function finalMdOf(");
    expect(src).toContain("':scope > .agent-md'"); // 组外直属 = 已结算最终正文
  });
});

describe("web 工作组（2026-10-13 设计 §3.7）：复制收窄为最终正文", () => {
  it("G5 源码锚定：turnTextsOf 退役——复制取组外最终块（中间过渡正文归过程不再入拷）", () => {
    const src = readFileSync(join(ASSETS_DIR, "render.js"), "utf8");
    expect(src).not.toContain("function turnTextsOf("); // 旧口径（全块并集）退役
    const copyFn = src.slice(src.indexOf("if (kind === 'copy')"), src.indexOf("} else if (kind === 'fork')"));
    expect(copyFn).toContain("finalMdOf(turn)"); // 组外直属最终正文
    expect(copyFn).toContain("claimBackward(turn)"); // straddle 兜底（只读不回挪——evalTurn 已认领）
    expect(copyFn).toContain("md.mdSource"); // markdown 源串（2026-10-13 复制批口径延续）
    expect(copyFn).toContain("replace(/^●\\s*/, '')"); // 流式残段无源串时退回渲染态（钉兜底正则）
    expect(copyFn).toContain("已复制本轮回复");
    expect(copyFn).toContain("（本轮无可复制文本）"); // 无正文轮兜底文案不变
    expect(src).not.toContain("自动合并两段"); // foot 复制钮 tooltip 旧并集口径同步退役（3c——用户可见标签不撒谎）
  });
});


describe("spawnIdsIn 结构化编号抠取（2026-10-13 走查修②——与 tasks-cmd 同口径互证）", () => {
  it("名册括号/旧汇总行/后台票行三形态 + 正文幻影 hex 不进", () => {
    const R = (globalThis as unknown as { OrosusRender: { spawnIdsIn: (o: string) => string[] } }).OrosusRender;
    const phantom = '正文引用 web_search_20250305 与 bucket 哈希 524861ea 与 spill-1-call_f96e14e5d41a4ae79bdc7a5f.txt';
    expect(R.spawnIdsIn(`子代理完成（8/8）[编号：34a85d8e、2f2d7d6a、3265d37f]：
- 34a85d8e · 完成 · 13 轮
${phantom}
- 2f2d7d6a · 完成 · 58 轮`))
      .toEqual(["34a85d8e", "2f2d7d6a", "3265d37f"]);
    expect(R.spawnIdsIn(`- 34a85d8e · 完成 · 13 轮
- 2f2d7d6a · 失败 · 3 轮
${phantom}`)).toEqual(["34a85d8e", "2f2d7d6a"]);
    expect(R.spawnIdsIn("后台已入册（2 个，跑完自动送回）：ab528ac7、d87f5b5a。期间去做别的")).toEqual(["ab528ac7", "d87f5b5a"]);
    expect(R.spawnIdsIn("派活失败：占位符误用")).toEqual([]);
  });
});

/* ── 走查修（2026-10-15 用户报障）：md 链接加固钩子——相对引用防导航劫持 ──
 *  病灶：MEMORY.md 索引类 viewText 内容里 [标题](笔记.md) 被渲染成真 <a href>，点击后
 *  浏览器原地导航到不存在的路由（URL 未带 token）→ 整页 {"ok":false,"error":"unauthorized"}。
 *  钩子三分支：外链加固新开标签；#锚点保留（文内滚动）；其余相对引用剥 href 标 md-ref（点击由
 *  app.js 委托提示）。钩子挂全局 DOMPurify 单例——ui.js mdHtml（viewText 大窗/dock 弹窗）同享。 */
interface FakeNode {
  tagName: string;
  attrs: Record<string, string>;
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
}
function fakeNode(tagName: string, attrs: Record<string, string>): FakeNode {
  const store: Record<string, string> = { ...attrs };
  return {
    tagName,
    attrs: store,
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k]! : null),
    setAttribute: (k, v) => { store[k] = v; },
    removeAttribute: (k) => { delete store[k]; },
  };
}
describe("走查修（2026-10-15）：md 链接加固钩子三分支 + 幂等注册", () => {
  it("① 相对引用（笔记 .md）：剥 href 防导航劫持，data-ref 存原文、class 追加 md-ref", () => {
    const n = fakeNode("A", { href: "user-declared-path-untouchable.md" });
    (R.mdLinkHook as Fn)(n);
    expect(n.attrs.href).toBeUndefined();
    expect(n.attrs["data-ref"]).toBe("user-declared-path-untouchable.md");
    expect(n.attrs["class"]).toBe("md-ref");
    const withCls = fakeNode("A", { href: "./sub/部署要点.md", class: "x" });
    (R.mdLinkHook as Fn)(withCls);
    expect(withCls.attrs["class"]).toBe("x md-ref");
    expect(withCls.attrs["data-ref"]).toBe("./sub/部署要点.md");
  });

  it("② 外链（http/https/协议相对）：rel=noopener noreferrer + target=_blank，href 原样保留", () => {
    const n = fakeNode("A", { href: "https://example.com/x?y=1" });
    (R.mdLinkHook as Fn)(n);
    expect(n.attrs.href).toBe("https://example.com/x?y=1");
    expect(n.attrs.rel).toBe("noopener noreferrer");
    expect(n.attrs.target).toBe("_blank");
    expect(n.attrs["class"]).toBeUndefined();
    const proto = fakeNode("A", { href: "//cdn.example.com/a.js" });
    (R.mdLinkHook as Fn)(proto);
    expect(proto.attrs.target).toBe("_blank");
  });

  it("③ #锚点/无 href 的 <a> 原样不动（文内滚动无路由语义）；img 剥 srcset 不动 src；非锚标签不碰", () => {
    const anchor = fakeNode("A", { href: "#sec-1" });
    (R.mdLinkHook as Fn)(anchor);
    expect(anchor.attrs).toEqual({ href: "#sec-1" });
    const bare = fakeNode("A", {});
    (R.mdLinkHook as Fn)(bare);
    expect(Object.keys(bare.attrs)).toHaveLength(0);
    const img = fakeNode("IMG", { src: "/api/media?path=a.png", srcset: "a 1x, b 2x" });
    (R.mdLinkHook as Fn)(img);
    expect(img.attrs.srcset).toBeUndefined();
    expect(img.attrs.src).toBe("/api/media?path=a.png");
    const span = fakeNode("SPAN", { class: "y" });
    (R.mdLinkHook as Fn)(span);
    expect(span.attrs["class"]).toBe("y");
  });

  it("④ ensureMdLinkHook：afterSanitizeAttributes 挂 mdLinkHook 本体（同引用）且幂等；无 addHook 面静默跳过", () => {
    const registered: Array<[string, Fn]> = [];
    const fakeDp = { addHook: (ev: string, fn: Fn) => { registered.push([ev, fn]); } };
    (R.ensureMdLinkHook as Fn)(fakeDp);
    (R.ensureMdLinkHook as Fn)(fakeDp);
    expect(registered).toHaveLength(1);
    expect(registered[0]![0]).toBe("afterSanitizeAttributes");
    expect(registered[0]![1]).toBe(R.mdLinkHook);
    expect((R.ensureMdLinkHook as Fn)(null)).toBeUndefined();
  });
});
