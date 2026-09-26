import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleContext } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import type { Fs } from "@orosus/contracts/fs";
import def from "./index.ts";
import { resolveShell } from "./shell.ts";

/** 最小 fake ctx：tool-shell 用到 services.get（消费 fs 能力）+ contribute.tool。 */
function fakeCtx(files: Map<string, string>): { ctx: ModuleContext; tools: Tool[] } {
  const tools: Tool[] = [];
  const fakeFs: Fs = {
    read: (p) => {
      const v = files.get(p);
      return v === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(v);
    },
    write: (p, c) => (files.set(p, c), Promise.resolve()),
  };
  const ctx = {
    config: undefined,
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    services: {
      get: (k: string) => (k === "fs" ? Promise.resolve(fakeFs) : Promise.reject(new Error(`无服务 ${k}`))),
      getOptional: () => Promise.resolve(undefined),
    },
    provide: () => {},
    contribute: {
      tool: (t: Tool) => (tools.push(t), () => {}),
      command: () => () => {},
      promptSection: () => () => {},
    },
    session: { append: () => {} },
    events: { on: () => () => {}, emit: () => Promise.resolve() },
  } as unknown as ModuleContext;
  return { ctx, tools };
}

const run = (tool: Tool, args: unknown) =>
  tool
    .resolveExecution(args)
    .then((exec) =>
      exec.execute({ callId: "c1", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } }),
    );

// 跨平台命令：node -e 在 cmd / sh 下行为一致
const OK_CMD = `node -e "process.stdout.write('ok')"`;
const FAIL_CMD = `node -e "process.stderr.write('boom'); process.exit(3)"`;

describe("tool-shell（能力消费者范例：dependsOn [fs]）", () => {
  it("声明依赖与 uses；bash 成功命令 → output", async () => {
    expect(def.dependsOn).toEqual(["fs"]);
    expect(def.uses).toContain("subprocess");
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    expect(tools.map((t) => t.name)).toEqual(["tool-shell__bash", "tool-shell__output", "tool-shell__kill"]); // T3 后台作业族三件套
    const exec = await tools[0]!.resolveExecution({ command: OK_CMD });
    expect(exec.approvalRule).toBe(`tool-shell__bash(${OK_CMD})`);
    const r = await run(tools[0]!, { command: OK_CMD });
    expect(r.isError).toBe(false);
    expect(r.output).toBe("ok");
  });

  it("退出码非 0 → isError + [退出码 N]，stderr 并入输出", async () => {
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    const r = await run(tools[0]!, { command: FAIL_CMD });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("[退出码 3]");
    expect(r.output).toContain("boom");
  });

  it("writeOutputTo 经 fs 能力落盘（消费方实证）", async () => {
    const files = new Map<string, string>();
    const { ctx, tools } = fakeCtx(files);
    await def.activate(ctx);
    const r = await run(tools[0]!, { command: OK_CMD, writeOutputTo: "out.txt" });
    expect(r.isError).toBe(false);
    expect(files.get("out.txt")).toBe("ok");
  });

  // GBK 字节「你好」——cmd 系工具（中文 Windows ANSI 代码页）的输出形态
  const GBK_CMD = `node -e "process.stdout.write(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))"`;
  it.skipIf(process.platform !== "win32")("Windows ANSI 代码页输出回退 GB18030 解码（2026-09-23 走查批图3 乱码前案）", async () => {
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    const r = await run(tools[0]!, { command: GBK_CMD });
    expect(r.output).toBe("你好"); // 不再是 U+FFFD 问号
    const ok = await run(tools[0]!, { command: OK_CMD });
    expect(ok.output).toBe("ok"); // UTF-8 输出不受影响
  });

  // 混合流（2026-09-23 走查再现实锤）：UTF-8 行（含合法 U+FFFD）+ GBK 行同流——按行各自择优，
  // 整段二选一必坏一边（旧实现计票被合法 U+FFFD 污染）
  const MIX_CMD = `node -e "process.stdout.write(Buffer.concat([Buffer.from('中文 UTF-8 行', 'utf8'), Buffer.from([0xef, 0xbf, 0xbd, 0x0a]), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from([0x0a])]))"`;
  it.skipIf(process.platform !== "win32")("UTF-8/GBK 混合流按行择优——UTF-8 行不毁、GBK 行可读", async () => {
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    const r = await run(tools[0]!, { command: MIX_CMD });
    expect(r.output).toContain("中文 UTF-8 行"); // UTF-8 行保持
    expect(r.output).toContain("你好"); // GBK 行回退解码
  });

  it("matchesRule 迷你 glob：后缀 * 前缀匹配，否则全等", async () => {
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    const exec = await tools[0]!.resolveExecution({ command: "git status" });
    expect(exec.matchesRule!("git *")).toBe(true);
    expect(exec.matchesRule!("git *")).toBe(true);
    expect(exec.matchesRule!("git status")).toBe(true);
    expect(exec.matchesRule!("git")).toBe(false);
    expect(exec.matchesRule!("rm *")).toBe(false);
  });
});

// M4-3 T2：workdir 参数 + 跨调用目录记忆（伪持久第一半，SW-9）
describe("tool-shell workdir + 目录记忆（M4-3 T2）", () => {
  const CWD_CMD = `node -e "process.stdout.write(process.cwd())"`;
  const mk = async () => {
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    return tools[0]!;
  };
  let dir: string | undefined;
  const tmp = () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-sh-wd-"));
    return dir;
  };
  afterEach(() => { if (dir !== undefined) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } });

  it("① 缺省继承进程 cwd（无记忆无参数）", async () => {
    const tool = await mk();
    const r = await run(tool, { command: CWD_CMD });
    expect(r.isError).toBe(false);
    expect(r.output).toBe(process.cwd());
  });

  it("② 显式 workdir 生效；成功后第二次无参继承记忆（不用每条都 cd）", async () => {
    const tool = await mk();
    const d = tmp();
    const r1 = await run(tool, { command: CWD_CMD, workdir: d });
    expect(r1.isError).toBe(false);
    expect(r1.output).toBe(d);
    const r2 = await run(tool, { command: CWD_CMD });
    expect(r2.output).toBe(d); // 记忆生效
  });

  it("③ 相对路径基于上次记忆解析（记忆/a/b + workdir c → /a/b/c）", async () => {
    const tool = await mk();
    const d = tmp();
    mkdirSync(join(d, "sub"));
    await run(tool, { command: CWD_CMD, workdir: d });
    const r = await run(tool, { command: CWD_CMD, workdir: "sub" });
    expect(r.output).toBe(join(d, "sub"));
  });

  it("④ 无记忆时相对路径基于进程 cwd", async () => {
    const tool = await mk();
    const d = tmp();
    void d;
    const r = await run(tool, { command: CWD_CMD, workdir: "." });
    expect(r.output).toBe(process.cwd());
  });

  it("⑤ 绝对路径 workdir 直接用（不经记忆基址）", async () => {
    const tool = await mk();
    const d = tmp();
    const r = await run(tool, { command: CWD_CMD, workdir: d });
    expect(r.output).toBe(d);
  });

  it("⑥ 目录不存在 → 回落进程 cwd + 结果说明（SW-9/cc-haha 同款兜底）", async () => {
    const tool = await mk();
    const d = tmp();
    const ghost = join(d, "ghost");
    const r = await run(tool, { command: CWD_CMD, workdir: ghost });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("不存在");
    expect(r.output).toContain("回落");
    expect(r.output).toContain(process.cwd());
  });

  it("⑦ workdir 指向文件（非目录）→ 同样回落 + 说明", async () => {
    const tool = await mk();
    const d = tmp();
    const f = join(d, "f.txt");
    writeFileSync(f, "x");
    const r = await run(tool, { command: CWD_CMD, workdir: f });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("回落");
  });

  it("⑧ 失败命令（退出码非 0）不改记忆", async () => {
    const tool = await mk();
    const d = tmp();
    const fail = await run(tool, { command: FAIL_CMD, workdir: d });
    expect(fail.isError).toBe(true);
    const r = await run(tool, { command: CWD_CMD });
    expect(r.output).toBe(process.cwd()); // 记忆未被失败命令污染
  });

  it("⑨ 超时不改记忆", async () => {
    const tool = await mk();
    const d = tmp();
    const t = await run(tool, { command: `node -e "setTimeout(()=>{},3000)"`, workdir: d, timeoutMs: 200 });
    expect(t.isError).toBe(true);
    expect(t.output).toContain("超时");
    const r = await run(tool, { command: CWD_CMD });
    expect(r.output).toBe(process.cwd());
  });

  it("⑩ 记忆链三连：workdir → 继承 → 再相对（同一激活实例跨调用）", async () => {
    const tool = await mk();
    const d = tmp();
    mkdirSync(join(d, "a"));
    mkdirSync(join(d, "a", "b"));
    expect((await run(tool, { command: CWD_CMD, workdir: d })).output).toBe(d);
    expect((await run(tool, { command: CWD_CMD, workdir: "a" })).output).toBe(join(d, "a"));
    expect((await run(tool, { command: CWD_CMD, workdir: "b" })).output).toBe(join(d, "a", "b"));
    expect((await run(tool, { command: CWD_CMD })).output).toBe(join(d, "a", "b")); // 无参继承最新
  });
});

// 走查批 2026-09-26：壳解析（Git Bash 优先）+ cmd 方言护栏整合接线
describe("tool-shell 壳解析 + cmd 方言护栏接线（走查批 2026-09-26）", () => {
  let prevShell: string | undefined;
  const useShell = (override?: string) => {
    if (prevShell === undefined) prevShell = process.env["OROSUS_TOOL_SHELL"];
    if (override === undefined) delete process.env["OROSUS_TOOL_SHELL"];
    else process.env["OROSUS_TOOL_SHELL"] = override;
  };
  const activateWith = async (override?: string) => {
    useShell(override);
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    return tools[0]!;
  };
  afterEach(() => {
    if (prevShell === undefined) delete process.env["OROSUS_TOOL_SHELL"];
    else process.env["OROSUS_TOOL_SHELL"] = prevShell;
    prevShell = undefined;
  });

  // 本机 Git Bash 是否可探测（⑥⑦ 的门槛：cmd 回落机上这两个 bash 壳用例无意义）
  const hasBash = process.platform === "win32" && resolveShell().kind === "bash";

  it.skipIf(process.platform !== "win32")("① cmd 壳：POSIX 管道在执行前拦截（教学文案，不真跑）", async () => {
    const tool = await activateWith("cmd");
    const r = await run(tool, { command: "git status | head -5" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("未执行");
    expect(r.output).toContain("head");
    expect(r.output).toContain("Select-Object");
  });

  it.skipIf(process.platform !== "win32")("② cmd 壳：后台请求同样先过护栏（不登记作业）", async () => {
    const tool = await activateWith("cmd");
    const r = await run(tool, { command: "git status | head -5", run_in_background: true });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("未执行");
  });

  it.skipIf(process.platform !== "win32")("③ cmd 壳：护栏漏网的命令不存在 → 退出码 + 就地翻译点名", async () => {
    const tool = await activateWith("cmd");
    const r = await run(tool, { command: "definitely_missing_cmd_xyz" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("退出码");
    expect(r.output).toContain("命令不存在");
    expect(r.output).toContain("definitely_missing_cmd_xyz");
  });

  it.skipIf(!hasBash)("④ 描述随方言：cmd 壳给黑名单替换表；bash 壳明说 Git Bash", async () => {
    const cmdTool = await activateWith("cmd");
    expect(cmdTool.description).toContain("cmd.exe");
    expect(cmdTool.description).toContain("findstr");
    const bashTool = await activateWith("bash");
    expect(bashTool.description).toContain("Git Bash");
  });

  it("⑤ 失败但有产出 → 标注「先读输出再决定重试」（不分壳方言）", async () => {
    const tool = await activateWith();
    const r = await run(tool, { command: FAIL_CMD });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("[退出码 3]");
    expect(r.output).toContain("boom");
    expect(r.output).toContain("先读输出");
  });

  it.skipIf(!hasBash)("⑥ bash 壳直通 POSIX 语法（环境变量前缀——cmd 方言必炸的形态）", async () => {
    const tool = await activateWith();
    const r = await run(tool, {
      command: `OROSUS_SHELL_PROBE=x node -e "process.stdout.write(process.env.OROSUS_SHELL_PROBE ?? 'none')"`,
    });
    expect(r.output).toBe("x");
  });
});
