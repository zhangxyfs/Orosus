import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("③ accesses 声明 fs.read + 沙箱边界（越出 → isError，同 read）", async () => {
    writeFileSync(join(dir, "in.txt"), "x");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const glob = tools.find((t) => t.name === "tool-fs__glob")!;
    const exec = await glob.resolveExecution({ pattern: "**/*.ts" });
    expect(exec.accesses).toEqual([{ kind: "fs.read", path: "**/*.ts" }]); // fs.read 声明（路径以 pattern 近似——M1 同款口径）
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

  it("① read offset=3 limit=4 → 第 3-6 行带行号 + 页脚", async () => {
    writeFileSync(join(dir, "big.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
    const tools = await setup();
    const r = await run(tools[0]!, { path: "big.txt", offset: 3, limit: 4 });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("3→line3");
    expect(r.output).toContain("6→line6");
    expect(r.output).toContain("第 3-6 行，共 10 行");
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
