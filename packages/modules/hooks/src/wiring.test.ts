import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Chunk, ProviderRequest, StreamFn } from "@orosus/contracts/provider";
import { providerSlotKey } from "@orosus/contracts/provider";
import { defineTool } from "@orosus/contracts/tool";
import { fakeModule } from "@orosus/testing";
import { InMemorySessionStore } from "@orosus/core";
import hooksDef from "./index.ts";

let dir: string;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

const hermetic = (d: string, hooksToml: string) => {
  // 单文件自指：config.toml 同开自读门（通用层见到事件表）与承载真实表（userConfigFile 指回自己）
  const userFile = join(d, "config.toml").split("\\").join("/");
  writeFileSync(join(d, "config.toml"), `provider = "fake/m"\n\n[hooks]\nuserConfigFile = "${userFile}"\n${hooksToml}`, "utf8");
  return { userFile, projectFile: join(d, "no-proj.toml"), catalogCacheFile: join(d, "no-cat.json"), env: {} };
};

const textChunk = (text: string): Chunk[] => [{ type: "text/delta", text }, { type: "finish", kind: "stop" }];
const toolChunk = (callId: string, argsJson: string): Chunk[] => [
  { type: "toolcall/argumentsDelta", callId, name: "m__t", argumentsDelta: argsJson },
  { type: "finish", kind: "stop" },
];

interface SetupOpts {
  script?: Chunk[][];
  hooksToml?: string;
  failingTool?: boolean;
}
const setup = async (opts: SetupOpts = {}) => {
  const { createHarness } = await import("@orosus/core");
  dir = mkdtempSync(join(tmpdir(), "orosus-hookwire-"));
  const executed: (string | undefined)[] = [];
  let requests: ProviderRequest[] = [];
  const provider = ((await import("@orosus/testing")) as typeof import("@orosus/testing")).fakeProvider(opts.script ?? [toolChunk("c1", '{"v":"orig"}'), textChunk("收工")]);
  requests = provider.requests;
  const toolMod = fakeModule("m", {
    mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "m__t",
        description: "探针",
        parameters: z.object({ v: z.string().optional() }),
        resolveExecution: async (args: { v?: string }) => ({
          accesses: [],
          approvalRule: `m__t(${args.v ?? ""} *)`,
          execute: async () => { executed.push(args.v); return opts.failingTool === true ? { output: "工具炸了", isError: true } : { output: `ran:${args.v ?? ""}`, isError: false }; },
        }),
      }));
    },
  });
  const providerMod = fakeModule("provider-fake", { activate(ctx) { ctx.provide(providerSlotKey("fake"), provider.stream); } });
  const h = await createHarness({
    store: new InMemorySessionStore(),
    sessionsDir: join(dir, "sessions"),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    modules: [providerMod, toolMod, hooksDef],
    config: { ...hermetic(dir, opts.hooksToml ?? ""), cliOverrides: { model: "fake/m" } },
  });
  return { h, executed, requests, dir };
};

const PRE_DENY_EXIT2 = `
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "cat > /dev/null; echo 不许跑 >&2; exit 2"
`;
const PRE_DENY_JSON = `
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "echo '{\\"permissionDecision\\":\\"deny\\",\\"reason\\":\\"json 拦\\"}'"
`;
const PRE_REWRITE = `
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "node -e \\"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({updatedInput:{v:'rewritten'}}))})\\""
`;

describe("工具三事件接线（m5-hooks T6——真实 harness + 真实子进程钩子）", () => {
  it("① deny·exit 2：工具结果 denied 带理由、工具零执行、hooks/run 落 deny 账", async () => {
    const { h, executed } = await setup({ hooksToml: PRE_DENY_EXIT2 });
    await h.prompt("干活");
    const events = await h.history();
    const result = events.find((e) => e.type === "tool/result") as { output?: string; denied?: boolean };
    expect(result?.output).toContain("钩子拦截：不许跑");
    expect(result?.denied).toBe(true);
    expect(executed).toEqual([]);
    const run = events.find((e) => e.type === "hooks/run") as Record<string, unknown>;
    expect(run).toMatchObject({ event: "PreToolUse", status: "deny", reason: "不许跑" });
    await h.close();
  });

  it("② deny·JSON：permissionDecision deny + reason 生效（stdout 决策面）", async () => {
    const { h, executed } = await setup({ hooksToml: PRE_DENY_JSON });
    await h.prompt("干活");
    const events = await h.history();
    const result = events.find((e) => e.type === "tool/result") as { output?: string };
    expect(result?.output).toContain("json 拦");
    expect(executed).toEqual([]);
    await h.close();
  });

  it("③ JSON ask 按无动作放行（ask 语义归 T8 PermissionRequest——本点位只折 deny/pass）", async () => {
    const { h, executed } = await setup({ hooksToml: `
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "echo '{\\"permissionDecision\\":\\"ask\\"}'"
` });
    await h.prompt("干活");
    expect(executed).toEqual(["orig"]); // 放行未被静默吞成 deny
    await h.close();
  });

  it("④ allow 无升档效力（D8）：放行即无动作——工具照常执行（升档只走 T8）", async () => {
    const { h, executed } = await setup({ hooksToml: `
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "echo '{\\"permissionDecision\\":\\"allow\\"}'"
` });
    await h.prompt("干活");
    expect(executed).toEqual(["orig"]);
    await h.close();
  });

  it("⑤ updatedInput 改参：执行用新参 + hooks/input-rewrite 修订账落在 tool/call 之后 tool/result 之前", async () => {
    const { h, executed } = await setup({ hooksToml: PRE_REWRITE });
    await h.prompt("干活");
    expect(executed).toEqual(["rewritten"]); // 修订语义：执行见新参，tool/call 历史不改
    const events = await h.history();
    const types = events.map((e) => e.type);
    const rewriteAt = events.findIndex((e) => e.type === "hooks/input-rewrite");
    expect(rewriteAt).toBeGreaterThan(types.lastIndexOf("tool/call"));
    expect(rewriteAt).toBeLessThan(types.indexOf("tool/result"));
    const rewrite = events[rewriteAt] as unknown as { callId?: string; from?: unknown; to?: unknown };
    expect(rewrite).toMatchObject({ callId: "c1", from: { v: "orig" }, to: { v: "rewritten" } });
    await h.close();
  });

  it("⑥ 改参后审批见最终参数（联动 T1）：tool/pre-execute 链上监听者收到的 args 是改后的", async () => {
    const { h } = await setup({ hooksToml: PRE_REWRITE });
    const approvals: unknown[] = [];
    h.graph().bus.on("tool/pre-execute", (p) => { approvals.push((p as { args: unknown }).args); }, "test-approval");
    await h.prompt("干活");
    expect(approvals).toEqual([{ v: "rewritten" }]);
    await h.close();
  });

  it("⑦ PostToolUse additionalContext 注入：steering 旁路（[非用户输入] 头 + host/hook 源）落日志 + 下个模型请求收到", async () => {
    const { h, requests } = await setup({
      hooksToml: `
[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
command = "echo '{\\"additionalContext\\":\\"格式化完成，共 3 个文件\\"}'"
`,
    });
    await h.prompt("干活");
    const events = await h.history();
    const steerMsgs = events
      .filter((e) => e.type === "agent/steering-message")
      .flatMap((e) => ((e as { messages?: { text: string; sourceModule: string }[] }).messages ?? []));
    const injected = steerMsgs.find((m) => m.text.includes("格式化完成"));
    expect(injected).toMatchObject({ sourceModule: "host/hook" });
    expect(injected!.text).toContain("[非用户输入] 钩子注入");
    expect(injected!.text).toContain("格式化完成，共 3 个文件");
    const second = requests[1];
    expect(JSON.stringify(second?.messages)).toContain("格式化完成"); // 注入进了模型上下文（非用户伪装）
    await h.close();
  });

  it("⑧ isError 分流：失败工具只触发 PostToolUseFailure 表、成功工具只触发 PostToolUse 表（matcher 同认工具名）", async () => {
    // 成功跑 + PostToolUseFailure-only 配置：钩子不该跑（hooks/run 无账）
    const ok = await setup({
      hooksToml: `
[[hooks.PostToolUseFailure]]
[[hooks.PostToolUseFailure.hooks]]
command = "echo '{\\"additionalContext\\":\\"失败善后\\"}'"
`,
    });
    await ok.h.prompt("干活");
    expect((await ok.h.history()).some((e) => e.type === "hooks/run")).toBe(false); // 成功工具不触发 Failure 表
    await ok.h.close();
    // 失败工具 + 同配置：钩子跑、注入落账
    const fail = await setup({
      failingTool: true,
      hooksToml: `
[[hooks.PostToolUseFailure]]
[[hooks.PostToolUseFailure.hooks]]
command = "echo '{\\"additionalContext\\":\\"失败善后\\"}'"
`,
    });
    await fail.h.prompt("干活");
    const events = await fail.h.history();
    expect(events.some((e) => e.type === "hooks/run" && JSON.stringify(e).includes("PostToolUseFailure"))).toBe(true);
    expect(JSON.stringify(events)).toContain("失败善后");
    await fail.h.close();
  });

  it("⑨ fail-open：钩子非零退出（error）不阻断——工具照常执行 + hooks/run 记 error 账", async () => {
    const { h, executed } = await setup({
      hooksToml: `
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "exit 1"
`,
    });
    await h.prompt("干活");
    expect(executed).toEqual(["orig"]);
    const run = (await h.history()).find((e) => e.type === "hooks/run") as Record<string, unknown>;
    expect(run?.status).toBe("error");
    await h.close();
  });

  it("⑩ fail-open·超时：全局 timeoutMs=1200，钩子 sleep 4 被杀——工具照常执行（模块激活态先行断言，防配置被 schema 拒后空洞通过）", async () => {
    const { h, executed } = await setup({
      hooksToml: `
timeoutMs = 1200

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "sleep 4"
`,
    });
    expect(h.graph().audit().find((a) => a.name === "hooks")?.state).toBe("active");
    const t0 = Date.now();
    await h.prompt("干活");
    expect(executed).toEqual(["orig"]);
    expect(Date.now() - t0).toBeLessThan(3500); // 超时被杀没拖满 4s
    const run = (await h.history()).find((e) => e.type === "hooks/run") as Record<string, unknown>;
    expect(run?.status).toBe("timeout");
    await h.close();
  });

  it("⑪ 串行 deny 粘滞短路：首钩子 deny 后第二个钩子不再跑（执行序 = 配置序）", async () => {
    const marker = (): string => join(dir, "second-ran");
    const { h } = await setup({
      hooksToml: `
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "cat > /dev/null; echo 首个拦截 >&2; exit 2"

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "touch \${OROSUS_PROJECT_DIR}/second-ran"
`,
    });
    await h.prompt("干活");
    expect((await import("node:fs")).existsSync(marker())).toBe(false); // deny 后短路，第二钩子没跑
    const runs = (await h.history()).filter((e) => e.type === "hooks/run");
    expect(runs).toHaveLength(1); // 只有首个的账
    await h.close();
  });
});
