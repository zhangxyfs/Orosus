import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore, type Harness } from "./index.ts";
import { fakeModule, fakeProviderModule } from "@orosus/testing";
import { normalizeTrustKey } from "./kernel/trust.ts";
import type { Chunk, ProviderRequest, StreamFn } from "@orosus/contracts/provider";
import { defineTool } from "@orosus/contracts/tool";
import type { ModuleDefinition } from "@orosus/contracts/module";

let dir: string;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const hermetic = (d: string) => ({ userFile: join(d, "no-user.toml"), projectFile: join(d, "no-proj.toml"), env: {} });
const script: Chunk[][] = [[{ type: "text/delta", text: "x" }, { type: "finish", kind: "stop" }]];

const boot = async (extra: { modules?: ModuleDefinition[]; commandUi?: Harness extends never ? never : never } = {} as never) => {
  dir = mkdtempSync(join(tmpdir(), "orosus-reload-"));
  dirs.push(dir);
  const h = await createHarness({
    store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
    modules: [fakeProviderModule("fake", script), ...(extra.modules ?? [])],
    config: { ...hermetic(dir), cliOverrides: { model: "fake/m" } },
  });
  return h;
};

const tool = (name: string) =>
  defineTool({ name, description: name, parameters: z.object({}), resolveExecution: async () => ({ execute: async () => ({ output: `out:${name}`, isError: false }) }) });

describe("harness.reload 与 /reload（§5.5/T15）", () => {
  it("① reload 空闲时立即执行、报告 Unchanged 全量（def 引用不变的 builtin/inline）", async () => {
    const extra = fakeModule("m", { activate() {} });
    const h = await boot({ modules: [extra] });
    const report = await h.reload();
    expect(report.unchanged).toContain("provider-fake");
    expect(report.unchanged).toContain("m");
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    await h.close();
  });

  it("② turn 进行中 reload 排队至 turn 边界（gate 释放后完成；cancel 中止同样触发边界）", async () => {
    // 挂起流的 provider：直到 gate 打开才产出 finish
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hanging: StreamFn = async function* (_req: ProviderRequest): AsyncIterable<Chunk> {
      await gate;
      yield { type: "finish", kind: "stop" };
    };
    const hangingProvider = fakeModule("provider-hang", { activate(ctx) { ctx.provide("provider:hang", hanging); } });
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir = mkdtempSync(join(tmpdir(), "orosus-reload-")), spillDir: join(dir, "spill"),
      modules: [hangingProvider],
      config: { ...hermetic(dir), cliOverrides: { model: "hang/h-1" } },
    });
    dirs.push(dir);
    const turnP = h.prompt("hi"); // 占坑（进行中）
    let settled = false;
    const reloadP = h.reload().then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // turn 未到边界，reload 排队
    release();
    await turnP;
    const report = await reloadP;
    expect(report.unchanged).toContain("provider-hang");
    await h.close();
  });

  it("③ 会话连续性：被换下模块的工具调用 → 带内 isError 文案（§5.5 专用，soft 墓碑）", async () => {
    const v1 = fakeModule("swapped", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(tool("swapped__t")); } });
    const h = await boot({ modules: [v1] });
    // 模拟"换下"：reload 时模块消失（inline modules 列表变化——同一 harness 无法变列表；用 registry 直测墓碑语义）
    const names = h.graph().tools.namesByOwner("swapped");
    expect(names).toEqual(["swapped__t"]);
    for (const n of names) h.graph().tools.tombstone(n);
    const res = await h.graph().tools.run({ id: "c1", name: "swapped__t", args: {} }, { signal: new AbortController().signal });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("已在 reload 中变更");
    expect(h.graph().tools.specs().map((t) => t.name)).toContain("swapped__t"); // 字节稳定：specs 仍含名
    await h.close();
  });

  it("④ /reload 经命令路由触发（内建命令表，D38）", async () => {
    const h = await boot({});
    const out = await h.prompt("/reload");
    expect(out).toContain("unchanged");
    expect(out).toContain("failed 无"); // failed 段（T2）：回显报失败清单——空态显式「无」
    await h.close();
  });

  it("⑤ 卸载半圈：enabled 翻 false → reload → removed 含该模块、工具出清单、调用带内被拒、audit 态 discovered", async () => {
    const extra = fakeModule("m", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(tool("m__t")); } });
    const h = await boot({ modules: [extra] });
    expect(h.graph().tools.specs().map((t) => t.name)).toContain("m__t"); // 前置：启动时在
    writeFileSync(join(dir, "no-user.toml"), "[m]\nenabled = false\n");
    const report = await h.reload();
    expect(report.removed).toContain("m"); // 修复口径：diff 两侧按启停过滤后 removed 才含翻转模块
    expect(h.graph().tools.specs().map((t) => t.name)).not.toContain("m__t");
    const res = await h.graph().tools.run({ id: "c1", name: "m__t", args: {} }, { signal: new AbortController().signal });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("未知工具");
    expect(h.graph().audit().find((a) => a.name === "m")?.state).toBe("discovered"); // 禁用 ≠ 降级（§5.4）
    await h.close();
  });

  it("⑥ 重挂半圈：接⑤再翻 true → reload → added 含该模块、failed 空、工具恢复可执行", async () => {
    const extra = fakeModule("m", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(tool("m__t")); } });
    const h = await boot({ modules: [extra] });
    writeFileSync(join(dir, "no-user.toml"), "[m]\nenabled = false\n");
    const first = await h.reload();
    expect(first.removed).toContain("m");
    writeFileSync(join(dir, "no-user.toml"), "[m]\nenabled = true\n");
    const second = await h.reload();
    expect(second.added).toContain("m");
    expect(second.failed).toEqual([]); // 干净重挂：不撞旧实例同名（假挂载修复的核心断言）
    const res = await h.graph().tools.run({ id: "c2", name: "m__t", args: {} }, { signal: new AbortController().signal });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("out:m__t");
    await h.close();
  });

  it("⑦ 启动即停用的模块运行期挂载（回归钉：现状即好，修完不许变坏）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-reload-"));
    dirs.push(dir);
    writeFileSync(join(dir, "no-user.toml"), "[m]\nenabled = false\n");
    const extra = fakeModule("m", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(tool("m__t")); } });
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      modules: [fakeProviderModule("fake", script), extra],
      config: { ...hermetic(dir), cliOverrides: { model: "fake/m" } },
    });
    expect(h.graph().audit().find((a) => a.name === "m")?.state).toBe("discovered"); // 启动即停用
    writeFileSync(join(dir, "no-user.toml"), "");
    const report = await h.reload();
    expect(report.added).toContain("m");
    expect(report.failed).toEqual([]);
    const res = await h.graph().tools.run({ id: "c3", name: "m__t", args: {} }, { signal: new AbortController().signal });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("out:m__t");
    await h.close();
  });

  it("⑧ CH-02 回归钉：reload 重读配置尊重注入的 projectFile——项目层启停 reload 后仍生效（旧实现硬编码 cwd 缺省路径，项目层整层丢失）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-reload-ch02-"));
    dirs.push(dir);
    const extra = fakeModule("m", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(tool("m__t")); } });
    const projFile = join(dir, "proj.toml"); // 显式注入的 projectFile（≠ cwd/.orosus/config.toml 缺省路径）
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      modules: [fakeProviderModule("fake", script), extra],
      config: { userFile: join(dir, "no-user.toml"), projectFile: projFile, env: {} },
    });
    expect(h.graph().audit().find((a) => a.name === "m")?.state).toBe("active"); // 前置：启动读注入的 projectFile
    writeFileSync(projFile, "[m]\nenabled = false\n");
    const report = await h.reload();
    expect(report.removed).toContain("m"); // 旧实现：projectFile 丢失 → reload 落回 cwd 缺省路径（不存在）→ 项目层不生效
    expect(h.graph().audit().find((a) => a.name === "m")?.state).toBe("discovered");
    await h.close();
  });
});

// ---- 本地（目录扫描）模块基建：CH-05/CK-06/CH-09 回归钉共用 ----
// 用户层信任预登记（m5 T17：一次性确认不追 hash）——条目存在即过门，测试免去首挂确认流
const bootLocal = async (opts: {
  entrySource: string;
  trustFile: string;
  dir: string;
  userDir: string;
}): Promise<Harness> => {
  writeFileSync(opts.trustFile, JSON.stringify({
    entries: { [normalizeTrustKey(join(opts.userDir, "echo-mod"))]: { hash: "registered", confirmedAt: "t" } },
  }));
  return createHarness({
    store: new InMemorySessionStore(), diagDir: opts.dir, spillDir: join(opts.dir, "spill"), cwd: opts.dir,
    discovery: { userDir: opts.userDir, projectDir: join(opts.dir, "no-proj"), trustFile: opts.trustFile },
    modules: [fakeProviderModule("fake", script)],
    config: { ...hermetic(opts.dir), cliOverrides: { model: "fake/m" } },
  });
};
const mkLocalDir = (): { userDir: string; entry: string; trustFile: string } => {
  dir = mkdtempSync(join(tmpdir(), "orosus-reload-local-")); // 赋外层 dir（同 boot 惯例——afterEach 清理挂钩）
  dirs.push(dir);
  const userDir = join(dir, "umods");
  mkdirSync(join(userDir, "echo-mod"), { recursive: true });
  return { userDir, entry: join(userDir, "echo-mod", "index.ts"), trustFile: join(dir, "trust.json") };
};
const modSource = (version: string, body = ""): string => `import { defineModule } from "@orosus/contracts/module";
export default defineModule({ name: "echo-mod", version: "${version}", description: "d", api: 1,
  activate() { ${body} } });
`;

describe("reload 回归钉（2026-09-28 code review：CH-05 / CK-06 / CH-09）", () => {
  it("⑨ CH-05：启动 defs 带 entryHash——首次 reload 信任 local 模块判 Unchanged（旧实现启动侧无 hash，undefined≠sha256 全量误重载）", async () => {
    const { userDir, entry, trustFile } = mkLocalDir();
    writeFileSync(entry, modSource("0.1.0"));
    const h = await bootLocal({ entrySource: "", trustFile, dir, userDir });
    expect(h.graph().audit().find((a) => a.name === "echo-mod")?.state).toBe("active"); // 前置：登记放行
    const r1 = await h.reload();
    expect(r1.unchanged).toContain("echo-mod"); // 首次 reload 不误重载（文件未动，entryHash 两侧一致）
    expect(r1.reloaded).toEqual([]);
    await h.close();
  });

  it("⑩ CK-06/CH-09①：并发 reload 折叠为同一次执行——报告同一对象、被换模块恰好再激活一次（旧实现双跑：共享 bus/tools 双激活 + 工具注册冲突降级）", async () => {
    const { userDir, entry, trustFile } = mkLocalDir();
    const marker = join(dir, "activations.txt");
    // 模板须写双反斜杠：生成源码里才是字面 \n 转义（appendFileSync 落 x+换行）——单反斜杠会产真换行炸模块语法
    const src = (version: string) => `import { appendFileSync } from "node:fs";
import { defineModule } from "@orosus/contracts/module";
export default defineModule({ name: "echo-mod", version: "${version}", description: "d", api: 1,
  activate() { appendFileSync(${JSON.stringify(marker)}, "x\\n"); } });
`;
    writeFileSync(entry, src("0.1.0"));
    const h = await bootLocal({ entrySource: "", trustFile, dir, userDir });
    const count = (): number => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((l) => l === "x").length : 0);
    expect(count()).toBe(1); // 启动激活 v1 一次
    writeFileSync(entry, src("0.2.0")); // 内容变 → entryHash 变 → 该模块 Reloaded
    const [r1, r2] = await Promise.all([h.reload(), h.reload()]); // 连击 / 确认→自动 reload 链路同型
    expect(r1).toBe(r2); // in-flight 折叠：同一 promise 的同一结果（旧实现两次执行 = 两份报告）
    expect(r1.reloaded).toContain("echo-mod");
    expect(count()).toBe(2); // 恰好再激活一次——旧实现双跑到 3（第二轮撞「工具注册冲突」降级）
    expect(h.graph().records.find((r) => r.name === "echo-mod")?.def.version).toBe("0.2.0"); // 新图就位
    await h.close();
  });

  it("⑪ CH-09②：reload 进行中新 prompt 同锁排队——turn 不再中途吃墓碑/换图，收尾顺序 reload → prompt", async () => {
    const { userDir, entry, trustFile } = mkLocalDir();
    const sentinel = join(dir, "sentinel.go"); // 哨兵文件：v2 activate 轮询等待——确定性挂起（非时序依赖）
    const src = (version: string, hang: boolean) => `import { existsSync } from "node:fs";
import { defineModule } from "@orosus/contracts/module";
export default defineModule({ name: "echo-mod", version: "${version}", description: "d", api: 1,
  async activate() {
    ${hang ? `while (!existsSync(${JSON.stringify(sentinel)})) await new Promise((r) => setTimeout(r, 5));` : ""}
  } });
`;
    writeFileSync(entry, src("0.1.0", false));
    const h = await bootLocal({ entrySource: "", trustFile, dir, userDir });
    expect(h.graph().audit().find((a) => a.name === "echo-mod")?.state).toBe("active");
    writeFileSync(entry, src("0.2.0", true)); // 换挂起版：reload 将卡在新图 activate
    const order: string[] = [];
    const rp = h.reload();
    void rp.then(() => order.push("reload"), () => order.push("reload-fail"));
    await new Promise((r) => setTimeout(r, 40)); // 走进挂起（哨兵不存在——挂起是无限的，此处等待只为观察点，非判据）
    const pp = h.prompt("hi");
    void pp.then(() => order.push("prompt"), () => order.push("prompt-fail"));
    await new Promise((r) => setTimeout(r, 40));
    expect(order).toEqual([]); // reload 未收尾：prompt 不得起 turn（旧实现 guard 见 currentTurn=null 放行）
    expect((await h.history()).some((e) => e.type === "user/message")).toBe(false); // 实证：user/message 未落
    writeFileSync(sentinel, ""); // 放行 activate
    await Promise.all([rp, pp]);
    expect(order).toEqual(["reload", "prompt"]); // 收尾顺序钉死：reload 先、prompt 的 turn 后起
    expect(h.graph().records.find((r) => r.name === "echo-mod")?.def.version).toBe("0.2.0");
    expect((await h.history()).some((e) => e.type === "user/message")).toBe(true); // turn 真跑了
    await h.close();
  });
});
