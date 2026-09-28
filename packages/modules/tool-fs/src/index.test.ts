import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleContext } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import type { Fs } from "@orosus/contracts/fs";
import def from "./index.ts";

/** 最小 fake ctx：只实现 tool-fs 用到的口（provide + contribute.tool）。 */
function fakeCtx(): { ctx: ModuleContext; services: Map<string, unknown>; tools: Tool[] } {
  const services = new Map<string, unknown>();
  const tools: Tool[] = [];
  const ctx = {
    config: undefined,
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    services: {
      get: () => Promise.reject(new Error("no services")),
      getOptional: () => Promise.resolve(undefined),
    },
    provide: (k: string, impl: unknown) => void services.set(k, impl),
    contribute: {
      tool: (t: Tool) => { tools.push(t); return () => {}; },
      command: () => () => {},
      promptSection: () => () => {},
    },
    session: { append: () => {} },
    events: { on: () => () => {}, emit: () => Promise.resolve() },
  } as unknown as ModuleContext;
  return { ctx, services, tools };
}

let dir: string;
let savedCwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orosus-toolfs-"));
  savedCwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(savedCwd);
  rmSync(dir, { recursive: true, force: true });
});

const run = async (tool: Tool, args: unknown) => {
  const exec = await tool.resolveExecution(args);
  return exec.execute({ callId: "c1", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
};

describe("tool-fs（规则 1 提供者 + 规则 5 同路径实证）", () => {
  it("提供 fs 服务与三个工具；read/write/edit 全链路", async () => {
    const { ctx, services, tools } = fakeCtx();
    await def.activate(ctx);
    expect(services.has("fs")).toBe(true);
    expect(tools.map((t) => t.name)).toEqual(["tool-fs__read", "tool-fs__write", "tool-fs__edit", "tool-fs__glob", "tool-fs__grep"]); // T16 起五件
    const [read, write, edit] = tools as [Tool, Tool, Tool];
    expect((await run(write, { path: "a.txt", content: "hello world" })).isError).toBe(false);
    expect((await run(read, { path: "a.txt" })).output).toBe("1→hello world\n(第 1-1 行，共 1 行)"); // T6 起行号标注
    expect((await run(edit, { path: "a.txt", edits: [{ oldText: "world", newText: "orosus" }] })).isError).toBe(false); // T6 起 edits[] 形态
    expect((await run(read, { path: "a.txt" })).output).toContain("hello orosus");
    const fs = services.get("fs") as Fs;
    expect(await fs.read("a.txt")).toBe("hello orosus");
  });

  it("read 不存在的文件 → 带内 isError", async () => {
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools[0]!, { path: "ghost.txt" });
    expect(r.isError).toBe(true);
  });

  it("edit：oldText 未找到或多处匹配 → isError", async () => {
    writeFileSync(join(dir, "b.txt"), "aa aa");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    expect((await run(tools[2]!, { path: "b.txt", edits: [{ oldText: "zz", newText: "x" }] })).isError).toBe(true);
    expect((await run(tools[2]!, { path: "b.txt", edits: [{ oldText: "aa", newText: "x" }] })).isError).toBe(true); // 多处匹配
  });

  it("路径越出根目录 → isError（安全沙箱边界）", async () => {
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools[0]!, { path: "../../../../etc/passwd" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("越出");
  });

  it("MB-02 符号链接逃逸拦截：工作区内链接指向根外 → read/write/edit 被拒（词法前缀挡不住链接外指）", async () => {
    const outside = mkdtempSync(join(tmpdir(), "orosus-toolfs-out-"));
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET", "utf8");
    try {
      symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return; // 本机无符号链接权限（Windows 非 dev-mode）——POSIX/dev-mode 上有效，静默跳过
    }
    try {
      symlinkSync(outside, join(dir, "linkdir"), "junction"); // 目录链接（Windows junction 免权限；POSIX 忽略类型）
      const { ctx, services, tools } = fakeCtx();
      await def.activate(ctx);
      const fs = services.get("fs") as Fs;
      expect(() => fs.read("linkdir/secret.txt")).toThrow(/符号链接越出根目录/); // 旧实现：读到根外 TOP SECRET（readFileSync 跟随链接）
      expect(() => fs.write("linkdir/secret.txt", "x")).toThrow(/符号链接越出根目录/);
      expect(() => fs.write("linkdir/new.txt", "x")).toThrow(/符号链接越出根目录/); // 新建文件经链接目录——最近存在祖先（linkdir）解析到根外，同拦
      expect((await run(tools[1]!, { path: "linkdir/secret.txt", content: "x" })).isError).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("glob/grep（T16，§12 M2）", () => {
  it("① tool-fs__glob：**/*.ts 模式匹配（Node 22 原生 fs.glob）", async () => {
    writeFileSync(join(dir, "a.ts"), "x");
    writeFileSync(join(dir, "b.js"), "x");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools.find((t) => t.name === "tool-fs__glob")!, { pattern: "**/*.ts" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("a.ts");
    expect(r.output).not.toContain("b.js");
  });

  it("② tool-fs__grep：内容正则搜索，输出 path:line:text", async () => {
    writeFileSync(join(dir, "g1.ts"), "line1\nTARGET here\nline3\n");
    writeFileSync(join(dir, "g2.ts"), "nope\n");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools.find((t) => t.name === "tool-fs__grep")!, { pattern: "TARGET" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("g1.ts:2:TARGET here");
    expect(r.output).not.toContain("g2.ts");
  });

  it("③ accesses 整根读声明 + 沙箱边界（越出 → isError，同 read）", async () => {
    writeFileSync(join(dir, "in.txt"), "x");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const glob = tools.find((t) => t.name === "tool-fs__glob")!;
    const exec = await glob.resolveExecution({ pattern: "**/*.ts" });
    // CT-04（2026-09-28 code review）：pattern 不再当路径塞进声明——glob/grep 按「整根读」声明字面绝对根路径，
    // 调度器前缀比较恢复真实语义（原 <cwd>/**/* 字面串与一切 fs.write 恒不冲突，串行承诺被绕开）
    expect(exec.accesses).toEqual([{ kind: "fs.read", path: realpathSync(dir) }]);
    const r = await run(glob, { pattern: "../../etc/**/*.conf" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("越出");
  });
});

describe("tool-fs 增强（M4-2 T6/B14——read 行区间+行号 / edit edits[] 原文件匹配 / grep 三模式 / glob 分页）", () => {
  const setup = async () => {
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    return tools;
  };

  it("① read offset=3 limit=4 → 第 3-6 行带行号 + 页脚（M4-2.5 T0 过账：区间有余量 → 续读提示形态）", async () => {
    writeFileSync(join(dir, "big.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
    const tools = await setup();
    const r = await run(tools[0]!, { path: "big.txt", offset: 3, limit: 4 });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("3→line3");
    expect(r.output).toContain("6→line6");
    expect(r.output).toContain("共 10 行，已显示 3-6");
    expect(r.output).toContain("offset=7");
  });

  it("② read 无 offset → 全文带行号", async () => {
    writeFileSync(join(dir, "big.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
    const tools = await setup();
    const r = await run(tools[0]!, { path: "big.txt" });
    expect(r.output).toContain("1→line1");
    expect(r.output).toContain("10→line10");
  });

  it("③ read offset 超界 → 空结果+提示，非 error", async () => {
    writeFileSync(join(dir, "big.txt"), "line1\nline2\n");
    const tools = await setup();
    const r = await run(tools[0]!, { path: "big.txt", offset: 99 });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("offset 超界");
  });

  it("④ edit edits=[两处不重叠] → 同时替换（基于原文件）", async () => {
    writeFileSync(join(dir, "edit.txt"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const tools = await setup();
    const r = await run(tools[2]!, {
      path: "edit.txt",
      edits: [
        { oldText: "const a = 1;", newText: "const alpha = 1;" },
        { oldText: "const c = 3;", newText: "const gamma = 3;" },
      ],
    });
    expect(r.isError).toBe(false);
    const after = readFileSync(join(dir, "edit.txt"), "utf8");
    expect(after).toContain("const alpha = 1;");
    expect(after).toContain("const gamma = 3;");
    expect(after).toContain("const b = 2;"); // 不受影响
  });

  it("⑤ edit edits 两处重叠 → 报错文件不变", async () => {
    writeFileSync(join(dir, "overlap.txt"), "aaa bbb ccc\n");
    const tools = await setup();
    const r = await run(tools[2]!, {
      path: "overlap.txt",
      edits: [
        { oldText: "aaa bbb", newText: "X" },
        { oldText: "bbb ccc", newText: "Y" }, // 与第一个重叠（bbb 共享）
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("重叠");
    expect(readFileSync(join(dir, "overlap.txt"), "utf8")).toBe("aaa bbb ccc\n"); // 文件未变
  });

  it("⑥ edit 单项 replaceAll → 全部替换", async () => {
    writeFileSync(join(dir, "multi.txt"), "old old old\n");
    const tools = await setup();
    const r = await run(tools[2]!, { path: "multi.txt", edits: [{ oldText: "old", newText: "new", replaceAll: true }] });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(dir, "multi.txt"), "utf8")).toBe("new new new\n");
  });

  it("⑥b edit edits[0] 找到但 edits[1] 找不到 → 整体失败文件不变（机制推演钉子）", async () => {
    writeFileSync(join(dir, "partial.txt"), "const a = 1;\n");
    const tools = await setup();
    const r = await run(tools[2]!, {
      path: "partial.txt",
      edits: [
        { oldText: "const a = 1;", newText: "const x = 1;" },
        { oldText: "NOT_EXIST", newText: "Y" }, // 这条找不到
      ],
    });
    expect(r.isError).toBe(true);
    expect(readFileSync(join(dir, "partial.txt"), "utf8")).toBe("const a = 1;\n"); // 文件不变
  });

  it("⑦ grep output_mode=files_with_matches → 仅文件名", async () => {
    writeFileSync(join(dir, "g1.ts"), "const target = 1;\n");
    writeFileSync(join(dir, "g2.ts"), "const other = 2;\n");
    const tools = await setup();
    const r = await run(tools.find((t) => t.name === "tool-fs__grep")!, { pattern: "target", output_mode: "files_with_matches" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("g1.ts");
    expect(r.output).not.toContain("g2.ts");
    expect(r.output).not.toContain(":1:"); // 非 content 模式
  });

  it("⑧ glob head_limit=2 → 截断+提示", async () => {
    writeFileSync(join(dir, "h1.txt"), "");
    writeFileSync(join(dir, "h2.txt"), "");
    writeFileSync(join(dir, "h3.txt"), "");
    const tools = await setup();
    const r = await run(tools.find((t) => t.name === "tool-fs__glob")!, { pattern: "h*.txt", head_limit: 2 });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("共 3 条");
    expect(r.output).toContain("仅显示前 2 条");
  });
});

describe("read 缺省窗口 + mtime 去重（M4-2.5 T0——日志体积调研 P1+P2）", () => {
  it("① 无 limit 读 >2000 行文件 → 只返回前 2000 行 + 续读提示", async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    writeFileSync(join(dir, "huge.txt"), big);
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools[0]!, { path: "huge.txt" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("1→line1");
    expect(r.output).toContain("2000→line2000");
    expect(r.output).not.toContain("2001→line2001");
    expect(r.output).toContain("共 2500 行");
    expect(r.output).toContain("offset=2001");
  });

  it("② 显式 limit 不受缺省窗口影响（读满 2500 行可带 limit）", async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    writeFileSync(join(dir, "huge.txt"), big);
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools[0]!, { path: "huge.txt", limit: 2500 });
    expect(r.output).toContain("2500→line2500");
  });

  it("③ ≤2000 行文件行为不变（缺省=全文）", async () => {
    writeFileSync(join(dir, "small.txt"), "a\nb\nc\n");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools[0]!, { path: "small.txt" });
    expect(r.output).toContain("3→c");
    expect(r.output).not.toContain("offset=4"); // 无续读提示
  });

  it("④ 同参重读且 mtime 未变 → file_unchanged 占位（不重复注入全文）", async () => {
    writeFileSync(join(dir, "dedup.txt"), "content\n");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r1 = await run(tools[0]!, { path: "dedup.txt" });
    expect(r1.output).toContain("1→content");
    const r2 = await run(tools[0]!, { path: "dedup.txt" });
    expect(r2.isError).toBe(false);
    expect(r2.output).toContain("file_unchanged");
    expect(r2.output).not.toContain("1→content");
  });

  it("⑤ mtime 变化（文件被改）→ 重新给全文", async () => {
    writeFileSync(join(dir, "dedup2.txt"), "v1\n");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    await run(tools[0]!, { path: "dedup2.txt" });
    writeFileSync(join(dir, "dedup2.txt"), "v2\n");
    // 强制 mtime 前移：同毫秒两次写在快速机器上可能同 mtimeMs（cc FILE_UNCHANGED 同款语义），测试不赌时序
    utimesSync(join(dir, "dedup2.txt"), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    const r = await run(tools[0]!, { path: "dedup2.txt" });
    expect(r.output).toContain("1→v2");
    expect(r.output).not.toContain("file_unchanged");
  });

  it("⑥ 不同行区间（不同 offset/limit）→ 不触发去重", async () => {
    writeFileSync(join(dir, "dedup3.txt"), "x\ny\nz\n");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    await run(tools[0]!, { path: "dedup3.txt", offset: 1, limit: 1 });
    const r = await run(tools[0]!, { path: "dedup3.txt", offset: 2, limit: 1 });
    expect(r.output).toContain("2→y");
    expect(r.output).not.toContain("file_unchanged");
  });

  it("㉓ 写前比对（M4.5 T7②/决策 24④）：读→他改→写被拦要求重读；mtime 漂移内容未变→放行；写后连续写不拦；edit 同拦", async () => {
    writeFileSync(join(dir, "guard.txt"), "v1\nline2\n");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const read = tools[0]!;   // tool-fs__read
    const write = tools[1]!;  // tool-fs__write
    const edit = tools[2]!;   // tool-fs__edit
    await run(read, { path: "guard.txt" }); // 模型读过（全量）

    // ① 读后被别人改 → 写被拦（要求重读）
    writeFileSync(join(dir, "guard.txt"), "别人改过的内容\nline2\n");
    utimesSync(join(dir, "guard.txt"), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000)); // 强制 mtime 前移（不赌时序）
    const blocked = await run(write, { path: "guard.txt", content: "按旧印象覆盖" });
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("读取后被修改过");
    const blockedEdit = await run(edit, { path: "guard.txt", edits: [{ oldText: "line2", newText: "x" }] });
    expect(blockedEdit.isError).toBe(true); // edit 同拦（模型侧读记录为准，edit 自带现读不豁免）

    // ② 重读后写 → 放行；随后连续写（write→edit）不被自己的写拦
    await run(read, { path: "guard.txt" });
    const ok = await run(write, { path: "guard.txt", content: "新内容\ntail\n" });
    expect(ok.isError).toBe(false);
    const chain = await run(edit, { path: "guard.txt", edits: [{ oldText: "tail", newText: "尾" }] });
    expect(chain.isError).toBe(false);

    // ③ Windows mtime 漂移但内容没变（全量读过回退内容比对）→ 放行
    utimesSync(join(dir, "guard.txt"), new Date(Date.now() + 20_000), new Date(Date.now() + 20_000));
    const drift = await run(write, { path: "guard.txt", content: "漂移后照写\n" });
    expect(drift.isError).toBe(false);

    // ④ 从没读过的文件直接写（新建）→ 不拦
    const fresh = await run(write, { path: "brand-new.txt", content: "新建\n" });
    expect(fresh.isError).toBe(false);
  });
});

// MB-03/MB-06/MB-07/CT-04（2026-09-28 code review）回归钉
// 强制 mtime 前移——不赌时序（同毫秒两次写在快速机器上可能同 mtimeMs）
const bumpMtime = (p: string, deltaMs = 10_000): void =>
  utimesSync(p, new Date(Date.now() + deltaMs), new Date(Date.now() + deltaMs));

describe("code review P1 批（2026-09-28）", () => {
  const setup = async () => {
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    return { tools, read: tools[0]!, write: tools[1]!, edit: tools[2]!,
      glob: tools.find((t) => t.name === "tool-fs__glob")!,
      grep: tools.find((t) => t.name === "tool-fs__grep")! };
  };

  it("MB-03 拼写变体同键（写前比对）：read('v.txt') 后外部改，write('./v.txt') 被拦——原始字符串键会被 ./ 变体绕过", async () => {
    writeFileSync(join(dir, "v.txt"), "v1\n");
    const t = await setup();
    await run(t.read, { path: "v.txt" }); // 模型读过（键 = 归一绝对路径）
    writeFileSync(join(dir, "v.txt"), "别人改过的内容\n");
    bumpMtime(join(dir, "v.txt"));
    const blocked = await run(t.write, { path: "./v.txt", content: "按旧印象覆盖" }); // ./ 变体拼写
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("读取后被修改过");
    const blockedEdit = await run(t.edit, { path: "./v.txt", edits: [{ oldText: "内容", newText: "x" }] });
    expect(blockedEdit.isError).toBe(true); // edit 同口径（键归一后变体也拦）
  });

  it("MB-03 拼写变体同键（mtime 去重）：read('d.txt') 后 read('./d.txt') → file_unchanged（原实现两键白注入全文）", async () => {
    writeFileSync(join(dir, "d.txt"), "content\n");
    const t = await setup();
    await run(t.read, { path: "d.txt" });
    const r2 = await run(t.read, { path: "./d.txt" });
    expect(r2.isError).toBe(false);
    expect(r2.output).toContain("file_unchanged");
  });

  it("MB-06 ① 非法正则 → 带内明确报错（不裸抛）", async () => {
    writeFileSync(join(dir, "g.ts"), "x\n");
    const t = await setup();
    const r = await run(t.grep, { pattern: "([" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("正则无效");
  });

  it("MB-06 ② 病态正则 (a+)+ → 静态拒绝并指引改写（ReDoS 先验——确定性单例，不赌时序）", async () => {
    writeFileSync(join(dir, "g.ts"), "x\n");
    const t = await setup();
    const r = await run(t.grep, { pattern: "(a+)+b" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("嵌套量词");
  });

  it("MB-06 ③ 合法量词组不受误伤：(?:ab)+ 与 (a|b)+ 正常命中", async () => {
    writeFileSync(join(dir, "ok.ts"), "ab ab\nzz\n");
    const t = await setup();
    const r1 = await run(t.grep, { pattern: "(?:ab)+" });
    expect(r1.isError).toBe(false);
    expect(r1.output).toContain("ok.ts:1");
    const r2 = await run(t.grep, { pattern: "(a|b)+" });
    expect(r2.isError).toBe(false);
    expect(r2.output).toContain("ok.ts:1");
  });

  it("MB-06 ④ 超长行（>4096 字符）跳过匹配——病态正则工作量上界（minified/bundle 行不进 test）", async () => {
    writeFileSync(join(dir, "min.js"), `NEEDLE${"x".repeat(5000)}\nshort NEEDLE line\n`);
    const t = await setup();
    const r = await run(t.grep, { pattern: "NEEDLE" });
    expect(r.isError).toBe(false);
    expect(r.output).not.toContain(":1:"); // 超长第 1 行被跳过
    expect(r.output).toContain(":2:short NEEDLE line"); // 短行照常命中
  });

  it("MB-07 ① 大文件闸：>1MB 拒绝整读，指引 grep/shell（statSync 前置于 readFileSync）", async () => {
    writeFileSync(join(dir, "fat.log"), `${"x".repeat(1_100_000)}\n`);
    const t = await setup();
    const r = await run(t.read, { path: "fat.log" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("文件过大");
    expect(r.output).toContain("grep");
  });

  it("MB-07 ② 二进制判定：含 NUL 字节 → 明确提示不注入乱码", async () => {
    writeFileSync(join(dir, "img.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x01]));
    const t = await setup();
    const r = await run(t.read, { path: "img.bin" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("二进制");
  });

  it("MB-07 ③ 单行超长（>8KB）截断并标注（minified 行不整行注入）", async () => {
    const longLine = `console.log("${"a".repeat(9000)}");`;
    writeFileSync(join(dir, "oneline.js"), `${longLine}\n`);
    const t = await setup();
    const r = await run(t.read, { path: "oneline.js" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain(`已截断：原 ${longLine.length} 字符`);
    expect(r.output.length).toBeLessThan(8192 + 500); // 输出主体 = 截断行（8192）+ 标注，不随行长膨胀
  });

  it("CT-04 ① read/write/edit 声明：Access.path 以 resolveAbs 绝对路径填充（./ 与 …/… 变体同声明，不再按 cwd 错位）", async () => {
    const t = await setup();
    const readEx = await t.read.resolveExecution({ path: "./sub/../c.ts" });
    expect(readEx.accesses).toEqual([{ kind: "fs.read", path: join(realpathSync(dir), "c.ts") }]);
    const writeEx = await t.write.resolveExecution({ path: "./w.ts", content: "x" });
    expect(writeEx.accesses).toEqual([{ kind: "fs.write", path: join(realpathSync(dir), "w.ts") }]);
    const editEx = await t.edit.resolveExecution({ path: "e.ts", edits: [{ oldText: "a", newText: "b" }] });
    expect(editEx.accesses).toEqual([{ kind: "fs.write", path: join(realpathSync(dir), "e.ts") }]);
  });

  it("CT-04 ② 越出根的声明回落原始串（声明阶段不抛，execute 内自会带内报错）", async () => {
    const t = await setup();
    const readEx = await t.read.resolveExecution({ path: "../../outside.txt" });
    expect(readEx.accesses).toEqual([{ kind: "fs.read", path: "../../outside.txt" }]);
  });

  it("CT-04 ③ grep 声明整根读（字面绝对路径），与根内写真实冲突（调度器前缀比较口径）", async () => {
    const t = await setup();
    const grepEx = await t.grep.resolveExecution({ pattern: "anything" });
    expect(grepEx.accesses).toEqual([{ kind: "fs.read", path: realpathSync(dir) }]);
  });
});

// code review P3 批（2026-09-28）：MB-09/MB-10/MB-11/MB-15
describe("code review P3 批（2026-09-28）", () => {
  const setup = async () => {
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    return { tools, edit: tools[2]!,
      glob: tools.find((t) => t.name === "tool-fs__glob")!,
      grep: tools.find((t) => t.name === "tool-fs__grep")! };
  };

  it("MB-09 ① >1MB 文件跳过 grep（大小闸 statSync 前置于读取——大文件不再白读一遍才判跳过）", async () => {
    writeFileSync(join(dir, "fatgrep.log"), `TARGET${"x".repeat(1_100_000)}\n`);
    const t = await setup();
    const r = await run(t.grep, { pattern: "TARGET" });
    expect(r.isError).toBe(false);
    expect(r.output).toBe("（无匹配）"); // 超限文件被跳过（即使内容本可命中）
  });

  it("MB-09 ② 命中达 200 上限 → 停扫 + 截断标注（宽匹配不再攒数十万条命中）", async () => {
    writeFileSync(join(dir, "wide.txt"), `${Array.from({ length: 250 }, (_, i) => `hit number ${i}`).join("\n")}\n`);
    const t = await setup();
    const r = await run(t.grep, { pattern: "hit" });
    expect(r.isError).toBe(false);
    const hits = r.output.split("\n").filter((l) => l.includes("wide.txt:"));
    expect(hits).toHaveLength(200); // 恰好 200 条
    expect(r.output).toContain("hit number 199"); // 第 200 条在
    expect(r.output).not.toContain("hit number 200"); // 第 201 条起不再扫
    expect(r.output).toContain("命中过多"); // 如实标注截断
  });

  it("MB-10 ① glob 结果只含文件不含目录（description 的 file paths only 落实）", async () => {
    writeFileSync(join(dir, "f1.txt"), "x");
    mkdirSync(join(dir, "subdir"));
    writeFileSync(join(dir, "subdir", "inner.txt"), "x");
    const t = await setup();
    const r = await run(t.glob, { pattern: "*" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("f1.txt");
    expect(r.output).not.toContain("subdir"); // 顶层目录不进结果
    const r2 = await run(t.glob, { pattern: "**/*" });
    expect(r2.output).toContain("inner.txt"); // 目录内文件照常命中
    expect(r2.output.split("\n").some((l) => l.endsWith("subdir"))).toBe(false); // 目录名本身不占结果行
  });

  it("MB-10 ② glob description 不再谎称 Respects .gitignore——如实写跳过集", async () => {
    const t = await setup();
    expect(t.glob.description).not.toContain(".gitignore"); // 旧文案承诺不实的根源
    expect(t.glob.description).toContain("node_modules"); // 如实声明跳过集
    expect(t.glob.description).toContain("directories excluded");
  });

  it("MB-11 ① 混合编辑：位置编辑插入的 newText 不被 replaceAll 二次替换（全部基于原文件同时匹配）", async () => {
    writeFileSync(join(dir, "mix.txt"), "keep old keep\n");
    const t = await setup();
    const r = await run(t.edit, {
      path: "mix.txt",
      edits: [
        { oldText: "keep old keep", newText: "FOO old BAR" }, // 插入文本含 replaceAll 的 oldText
        { oldText: "old", newText: "NEW", replaceAll: true },
      ],
    });
    expect(r.isError).toBe(false);
    // 旧实现（replaceAll 作用于位置编辑后的结果串）：插入的 old 被二次替换 → "FOO NEW BAR"
    expect(readFileSync(join(dir, "mix.txt"), "utf8")).toBe("FOO old BAR\n");
  });

  it("MB-11 ② replaceAll 仍作用于位置编辑之外的原文区段（修序不废全替换）", async () => {
    writeFileSync(join(dir, "mix2.txt"), "old X old\n");
    const t = await setup();
    const r = await run(t.edit, {
      path: "mix2.txt",
      edits: [
        { oldText: "X", newText: "MID" },
        { oldText: "old", newText: "NEW", replaceAll: true },
      ],
    });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(dir, "mix2.txt"), "utf8")).toBe("NEW MID NEW\n"); // 两侧原文区段的 old 照常全替换
  });

  it("MB-15 模块 description 补全五工具（read/write/edit/glob/grep——README 同步）", () => {
    expect(def.description).toContain("glob");
    expect(def.description).toContain("grep");
  });
});
