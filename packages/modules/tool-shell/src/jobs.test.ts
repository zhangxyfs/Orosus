import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import toolFs from "@orosus/tool-fs";
import type { Chunk } from "@orosus/contracts/provider";
import type { ModuleContext } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import type { Fs } from "@orosus/contracts/fs";
import { JobRegistry } from "./jobs.ts";
import def, { killAllBackgroundJobs } from "./index.ts";

let dir: string;
let prevHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orosus-jobs-"));
  prevHome = process.env["OROSUS_HOME"];
  process.env["OROSUS_HOME"] = dir; // HERMETIC：模块 bg 目录解析走 orosusHome 单点
});
afterEach(() => {
  killAllBackgroundJobs(); // 兜底：测试启动的作业不跨用例存活
  if (prevHome === undefined) delete process.env["OROSUS_HOME"];
  else process.env["OROSUS_HOME"] = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

const noLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const waitFor = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const OK_BG = `node -e "process.stdout.write('bg-ok')"`;
const SLEEP_BG = `node -e "setTimeout(()=>process.stdout.write('late'),400)"`;

/** 带事件捕获的 fake ctx（index.test.ts 同族扩 events.on 记录）。 */
function fakeCtx(): { ctx: ModuleContext; tools: Tool[]; listeners: Map<string, ((p: unknown) => unknown)[]> } {
  const tools: Tool[] = [];
  const listeners = new Map<string, ((p: unknown) => unknown)[]>();
  const fakeFs: Fs = {
    read: () => Promise.reject(new Error("ENOENT")),
    write: () => Promise.resolve(),
  };
  const ctx = {
    config: undefined, configRead: () => Promise.resolve(undefined), log: noLog,
    services: { get: (k: string) => (k === "fs" ? Promise.resolve(fakeFs) : Promise.reject(new Error(`无服务 ${k}`))), getOptional: () => Promise.resolve(undefined) },
    provide: () => {},
    contribute: { tool: (t: Tool) => (tools.push(t), () => {}), command: () => () => {}, promptSection: () => () => {} },
    session: { append: () => {} },
    events: { on: (type: string, l: (p: unknown) => unknown) => { const arr = listeners.get(type) ?? []; arr.push(l); listeners.set(type, arr); return () => {}; }, emit: () => Promise.resolve() },
  } as unknown as ModuleContext;
  return { ctx, tools, listeners };
}

const run = (tool: Tool, args: unknown) =>
  tool.resolveExecution(args).then((exec) => exec.execute({ callId: "c1", signal: new AbortController().signal, log: noLog }));

describe("JobRegistry 后台作业注册表（M4-3 T3）", () => {
  it("① start → id 形态 bg-<8 位> + 输出文件存在 + 作业在册（立即返回不等完成）", async () => {
    const reg = new JobRegistry(dir);
    const job = reg.start(SLEEP_BG);
    expect(job.id).toMatch(/^bg-[0-9a-f]{8}$/);
    expect(job.file).toBe(join(dir, `${job.id}.output`));
    expect(existsSync(job.file)).toBe(true);
    expect(job.done).toBeUndefined(); // 立即返回——不等命令完成
    await waitFor(() => job.done !== undefined);
  });

  it("② 完成通知：close 后 drain 出一条（含退出码与字符数）；二次 drain 空（一次一报）", async () => {
    const reg = new JobRegistry(dir);
    const job = reg.start(OK_BG);
    expect(reg.drainNotifications()).toEqual([]); // 未结束不报
    await waitFor(() => job.done !== undefined);
    const notes = reg.drainNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain(`后台作业 ${job.id} 已结束（退出码 0`);
    expect(notes[0]!.text).toContain("字符）");
    expect(notes[0]!.text).toContain("tool-shell__output");
    expect(notes[0]!.sourceModule).toBe("tool-shell");
    expect(reg.drainNotifications()).toEqual([]);
  });

  it("③ readTail 尾部截取 + 状态标记（running → done 退出码）", async () => {
    const reg = new JobRegistry(dir);
    const job = reg.start(`node -e "process.stdout.write('x'.repeat(500))"`);
    await waitFor(() => job.done !== undefined);
    const r = reg.readTail(job.id, 100)!;
    expect(r.text).toBe("x".repeat(100)); // 尾部 100 字符
    expect(r.totalChars).toBe(500);
    expect(r.state).toBe("done");
    expect(r.code).toBe(0);
    const running = reg.start(SLEEP_BG);
    const r2 = reg.readTail(running.id, 100)!;
    expect(r2.state).toBe("running");
    await waitFor(() => running.done !== undefined);
  });

  it("④ readTail 字符语义非字节——CJK 尾部截取不劈半（SW-6）", async () => {
    const reg = new JobRegistry(dir);
    const job = reg.start(`node -e "process.stdout.write('汉'.repeat(300))"`);
    await waitFor(() => job.done !== undefined);
    const r = reg.readTail(job.id, 50)!;
    expect(r.text).toBe("汉".repeat(50)); // 恰好 50 个完整汉字（按字节切会出 U+FFFD 或长度不符）
    expect(r.text).not.toContain("�");
  });

  it("⑤ kill → 进程树死 + done 置位 + 完成通知照发（含退出码）", async () => {
    const reg = new JobRegistry(dir);
    const job = reg.start(`node -e "setTimeout(()=>{},60000)"`);
    expect(reg.kill(job.id)).toBe(true);
    await waitFor(() => job.done !== undefined);
    const notes = reg.drainNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("已结束");
  });

  it("⑥ kill 未知 id → false；readTail 未知 id → undefined", () => {
    const reg = new JobRegistry(dir);
    expect(reg.kill("bg-ghost00")).toBe(false);
    expect(reg.readTail("bg-ghost00", 100)).toBeUndefined();
  });

  it("⑦ 输出追加写：多段输出全进文件（stdout/stderr 合并同流）", async () => {
    const reg = new JobRegistry(dir);
    const job = reg.start(`node -e "process.stdout.write('out1'); process.stderr.write('err1'); process.stdout.write('out2')"`);
    await waitFor(() => job.done !== undefined);
    const content = readFileSync(job.file, "utf8");
    expect(content).toContain("out1");
    expect(content).toContain("err1");
    expect(content).toContain("out2");
  });

  it("⑧ killAll/dispose/宿主口三层清杀：活作业全死", async () => {
    const reg = new JobRegistry(dir);
    const j1 = reg.start(`node -e "setTimeout(()=>{},60000)"`);
    const j2 = reg.start(`node -e "setTimeout(()=>{},60000)"`);
    reg.killAll();
    await waitFor(() => j1.done !== undefined && j2.done !== undefined);
    // 模块 dispose 层：激活启动的 unregister 作业随 dispose 清杀
    const { ctx, tools } = fakeCtx();
    const ret = await def.activate(ctx);
    await tools[0]!.resolveExecution({ command: `node -e "setTimeout(()=>{},60000)"`, run_in_background: true })
      .then((exec) => exec.execute({ callId: "c9", signal: new AbortController().signal, log: noLog }));
    ret?.dispose?.(); // dispose 即 killAll（不挂起等待——killTree 是即发即弃）
    // 宿主口：再启动一个，killAllBackgroundJobs() 清杀（cc-haha registerCleanup 同款）
    const ret2 = await def.activate(ctx);
    await tools[0]!.resolveExecution({ command: `node -e "setTimeout(()=>{},60000)"`, run_in_background: true })
      .then((exec) => exec.execute({ callId: "c10", signal: new AbortController().signal, log: noLog }));
    killAllBackgroundJobs();
    ret2?.dispose?.();
  });
});

describe("tool-shell 后台三工具面（M4-3 T3）", () => {
  const mkTools = async () => {
    const { ctx, tools, listeners } = fakeCtx();
    const ret = await def.activate(ctx);
    return { ctx, tools, listeners, dispose: ret?.dispose };
  };

  it("⑨ bash run_in_background → 立即返回话术（id/输出文件/勿轮询）+ 作业真跑（文件后验有输出）", async () => {
    const { tools, dispose } = await mkTools();
    const r = await run(tools[0]!, { command: SLEEP_BG, run_in_background: true });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("后台作业 bg-");
    expect(r.output).toContain("输出文件");
    expect(r.output).toContain("勿轮询");
    const id = /bg-[0-9a-f]{8}/.exec(r.output)![0]!;
    expect(existsSync(join(dir, "bg", `${id}.output`))).toBe(true);
    await waitFor(() => readFileSync(join(dir, "bg", `${id}.output`), "utf8").includes("late"));
    dispose?.();
  });

  it("⑩ 后台作业无超时（SW-7）：前台会被 timeoutMs 杀的命令，后台照常跑完", async () => {
    const { tools, dispose } = await mkTools();
    const fg = await run(tools[0]!, { command: `node -e "setTimeout(()=>process.stdout.write('never'),3000)"`, timeoutMs: 200 });
    expect(fg.isError).toBe(true);
    expect(fg.output).toContain("超时");
    const bg = await run(tools[0]!, { command: `node -e "setTimeout(()=>process.stdout.write('done300'),300)"`, run_in_background: true });
    expect(bg.isError).toBe(false);
    const id = /bg-[0-9a-f]{8}/.exec(bg.output)![0]!;
    await waitFor(() => readFileSync(join(dir, "bg", `${id}.output`), "utf8").includes("done300"));
    dispose?.();
  });

  it("⑪ 后台尊重 workdir（输出 cwd 落盘）但不改记忆（下条前台命令仍在进程 cwd）", async () => {
    const { tools, dispose } = await mkTools();
    const sub = join(dir, "wd");
    mkdirSync(sub);
    const r = await run(tools[0]!, { command: `node -e "process.stdout.write(process.cwd())"`, workdir: sub, run_in_background: true });
    const id = /bg-[0-9a-f]{8}/.exec(r.output)![0]!;
    await waitFor(() => readFileSync(join(dir, "bg", `${id}.output`), "utf8").includes("wd"));
    const fg = await run(tools[0]!, { command: `node -e "process.stdout.write(process.cwd())"` });
    expect(fg.output).toBe(process.cwd()); // 记忆未被后台启动污染（成败未知不记——T2 规矩）
    dispose?.();
  });

  it("⑫ output 工具：尾部读取 + 状态头；未知 id 带内报错；accesses 声明 fs.read 作业文件（SW-8 只读放行）", async () => {
    const { tools, dispose } = await mkTools();
    const output = tools.find((t) => t.name === "tool-shell__output")!;
    const miss = await run(output, { id: "bg-ghost00" });
    expect(miss.isError).toBe(true);
    expect(miss.output).toContain("无此后台作业");
    await run(tools[0]!, { command: OK_BG, run_in_background: true });
    await waitFor(() => existsSync(join(dir, "bg")) && readdirSync(join(dir, "bg")).length > 0);
    const file = readdirSync(join(dir, "bg"))[0]!;
    const id = file.replace(".output", "");
    await waitFor(() => readFileSync(join(dir, "bg", file), "utf8").includes("bg-ok"));
    const plan = await output.resolveExecution({ id });
    expect(plan.accesses).toEqual([{ kind: "fs.read", path: join(dir, "bg", file) }]);
    const r = await plan.execute({ callId: "c2", signal: new AbortController().signal, log: noLog });
    expect(r.isError).toBe(false);
    expect(r.output).toContain(id);
    expect(r.output).toContain("bg-ok");
    dispose?.();
  });

  it("⑬ kill 工具：空 accesses 声明（SW-8——误声明 subprocess 两档都被问）+ kill 后通知照发", async () => {
    const { tools, listeners, dispose } = await mkTools();
    const kill = tools.find((t) => t.name === "tool-shell__kill")!;
    const plan = await kill.resolveExecution({ id: "x" });
    expect(plan.accesses).toEqual([]);
    const miss = await run(kill, { id: "bg-ghost00" });
    expect(miss.isError).toBe(true);
    await run(tools[0]!, { command: `node -e "setTimeout(()=>{},60000)"`, run_in_background: true });
    await waitFor(() => readdirSync(join(dir, "bg")).length > 0);
    const file = readdirSync(join(dir, "bg"))[0]!;
    const id = file.replace(".output", "");
    const ok = await run(kill, { id });
    expect(ok.isError).toBe(false);
    expect(ok.output).toContain("已停止");
    const followUp = listeners.get("agent/follow-up")!;
    await waitFor(() => (followUp[0]!(undefined) as unknown[]).length > 0);
    dispose?.();
  });

  it("⑭ followUp 订阅：激活即注册 agent/follow-up；collect 得 {text, sourceModule} 通知条目", async () => {
    const { tools, listeners, dispose } = await mkTools();
    const followUp = listeners.get("agent/follow-up");
    expect(followUp).toHaveLength(1);
    expect(followUp![0]!(undefined)).toEqual([]); // 无作业完成 = 空数组（collect 语义）
    await run(tools[0]!, { command: OK_BG, run_in_background: true });
    // 完成信号要等 collect 出货本身：job.done 挂在 close 事件上，输出文件有内容 ≠ close 已置（⑮ 同款竞速教训）；
    // collect 是 drain 语义（一次一报），轮询期间取到的条目就地留存
    let notes: { text: string; sourceModule: string }[] = [];
    await waitFor(() => {
      notes = followUp![0]!(undefined) as typeof notes;
      return notes.length > 0;
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.sourceModule).toBe("tool-shell");
    expect(notes[0]!.text).toContain("已结束");
    expect(followUp![0]!(undefined)).toEqual([]); // 一次一报
    dispose?.();
  });

  it("⑮ harness 集成：后台启动 → 作业真完成 → 下一轮停顿时通知作 steering 注入会话", async () => {
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "tool-shell__bash",
          argumentsDelta: JSON.stringify({ command: OK_BG, run_in_background: true }) },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "已启动" }, { type: "finish", kind: "stop" }],
      [{ type: "text/delta", text: "收到通知" }, { type: "finish", kind: "stop" }],
      [{ type: "text/delta", text: "收尾" }, { type: "finish", kind: "stop" }],
    ];
    const mem = new InMemorySessionStore();
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [toolFs, def, fakeProviderModule("fake", script)],
      config: { userFile: join(dir, "n.toml"), projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("后台跑一下"); // 第一轮：启动即返 + 脚本 stop（此刻作业大概率未完成——collect 空）
    // 作业完成时机与脚本消费竞速（两连实锤：文件有内容 ≠ close 已置 done——负载下窗口拉开）。
    // 确定性形态：轮询补发 nudge（fakeProvider 末段重复 text/stop 无害），每轮停顿时 collect 复查，
    // 作业 done 后下一轮必 steering——上限内必达，不再依赖单次时序
    let steering = "";
    for (let nudge = 0; nudge < 10 && steering === ""; nudge++) {
      await h.prompt("nudge");
      steering = (await mem.all()).filter((e) => e.type === "agent/steering-message").map((e) => JSON.stringify(e)).join("\n");
      if (steering === "") await new Promise((r) => setTimeout(r, 120)); // 每轮留一拍给作业 close——nudge 全速冲会跑在作业完成前（三诊实锤）
    }
    await h.close();
    const all = await mem.all();
    const start = all.find((e) => e.type === "tool/result" && e.callId === "c1");
    expect(String(start && JSON.stringify(start))).toContain("后台作业 bg-");
    expect(steering).toContain("已结束（退出码 0");
    expect(steering).toContain("bg-");
  });

  it("⑯ 与 turn 取消脱钩：Esc 取消回答不杀后台作业（脱离语义——作业照跑到完成）", async () => {
    const { tools, dispose } = await mkTools();
    const ctl = new AbortController();
    const plan = await tools[0]!.resolveExecution({ command: SLEEP_BG, run_in_background: true });
    const r = await plan.execute({ callId: "c1", signal: ctl.signal, log: noLog });
    const id = /bg-[0-9a-f]{8}/.exec(r.output)![0]!;
    ctl.abort(); // turn 取消
    await waitFor(() => readFileSync(join(dir, "bg", `${id}.output`), "utf8").includes("late")); // 作业照跑
    dispose?.();
  });
});
