import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Chunk, ProviderRequest } from "@orosus/contracts/provider";
import { providerSlotKey } from "@orosus/contracts/provider";
import { defineTool, Access } from "@orosus/contracts/tool";
import { fakeModule, fakeProvider } from "@orosus/testing";
import { InMemorySessionStore } from "@orosus/core";
import hooksDef from "./index.ts";
import { projectBucketKey, projectHooksDigest } from "./trust.ts";

let dir: string;
afterEach(async () => {
  if (dir === undefined) return;
  for (let i = 0; i < 4; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 150)); } // 垂死 taskkill 进程占 cwd 句柄——重试容忍
  }
});

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
    cwd: dir, // 钩子 projectDir 跟会话 cwd（session/start 载荷）——marker/模板变量全落密封 tmp，不污染仓库根
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
    expect(result?.output).toContain("钩子拦截（cat）：不许跑"); // T11 阻断明示：带钩子来源可辨识
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
    const runs = (await h.history()).filter((e) => e.type === "hooks/run") as Record<string, unknown>[];
    expect(runs.some((r) => r.status === "running")).toBe(true); // ≥300ms 显形账（T11 状态行数据源）
    expect(runs.some((r) => r.status === "timeout")).toBe(true);
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

describe("提交/会话/停止三事件接线（m5-hooks T7）", () => {
  it("① UserPromptSubmit 阻断：prompt 带因拒绝、消息不落日志（Claude 拒收语义）", async () => {
    const { h } = await setup({
      script: [textChunk("ok")],
      hooksToml: `
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
command = "cat > /dev/null; echo 这话题不许聊 >&2; exit 2"
`,
    });
    await expect(h.prompt("危险话题")).rejects.toThrow("这话题不许聊");
    const events = await h.history();
    expect(events.some((e) => e.type === "user/message" && JSON.stringify(e).includes("危险话题"))).toBe(false);
    await h.close();
  });

  it("② UserPromptSubmit additionalContext → contextNotes 通道：[非用户输入] 头注入进首轮请求", async () => {
    const { h, requests } = await setup({
      script: [textChunk("ok")],
      hooksToml: `
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
command = "echo '{\\"additionalContext\\":\\"项目规矩：测试跑 pnpm vitest\\"}'"
`,
    });
    await h.prompt("干活");
    const events = await h.history();
    const msgs = events.filter((e) => e.type === "agent/steering-message").flatMap((e) => ((e as { messages?: { text: string; sourceModule: string }[] }).messages ?? []));
    const note = msgs.find((m) => m.text.includes("项目规矩"));
    expect(note).toMatchObject({ sourceModule: "host/hook" });
    expect(note!.text).toContain("[非用户输入]");
    expect(JSON.stringify(requests[0]?.messages)).toContain("项目规矩"); // 首轮请求就收到（T2 下个 step 排空）
    await h.close();
  });

  it("③ UserPromptSubmit matcher 恒忽略（无匹配值事件——写了不报错照样触发）", async () => {
    const { h } = await setup({
      script: [textChunk("ok")],
      hooksToml: `
[[hooks.UserPromptSubmit]]
matcher = "^never-match-anything$"
[[hooks.UserPromptSubmit.hooks]]
command = "cat > /dev/null; echo matcher 不生效 >&2; exit 2"
`,
    });
    await expect(h.prompt("任意话")).rejects.toThrow("matcher 不生效");
    await h.close();
  });

  it("④ SessionStart 注入进首轮（startup 时钩子跑完 → 队列在首个 step 排空进上下文）", async () => {
    const { h, requests } = await setup({
      script: [textChunk("ok")],
      hooksToml: `
[[hooks.SessionStart]]
matcher = "startup|resume|fork"
[[hooks.SessionStart.hooks]]
command = "echo '{\\"additionalContext\\":\\"启动知识：本仓构建用 pnpm\\"}'"
`,
    });
    await new Promise((r) => setTimeout(r, 400)); // 等 session/start 异步派发落队列（真机用户首条消息远慢于此）
    await h.prompt("干活");
    expect(JSON.stringify(requests[0]?.messages)).toContain("启动知识");
    await h.close();
  });

  it("⑤ Stop 阻断续跑一次：首停 exit 2 → 带理由续跑（sourceModule=hooks 落账）→ 二停放行", async () => {
    const { h, requests } = await setup({
      script: [textChunk("第一答"), textChunk("第二答")],
      hooksToml: `
[[hooks.Stop]]
[[hooks.Stop.hooks]]
command = "test -f \\"\${OROSUS_PROJECT_DIR}/stopmark\\" && exit 0 || { touch \\"\${OROSUS_PROJECT_DIR}/stopmark\\"; echo 还有活没干完 >&2; exit 2; }"
`,
    });
    await h.prompt("干活");
    expect(requests).toHaveLength(2); // 续跑产生了第二个请求
    const events = await h.history();
    const msgs = events.filter((e) => e.type === "agent/steering-message").flatMap((e) => ((e as { messages?: { text: string; sourceModule: string }[] }).messages ?? []));
    const cont = msgs.find((m) => m.text.includes("钩子要求继续"));
    expect(cont).toMatchObject({ sourceModule: "hooks" });
    expect(cont!.text).toContain("还有活没干完");
    expect(JSON.stringify(requests[1]?.messages)).toContain("还有活没干完"); // 续跑消息进了模型上下文
    await h.close();
  });

  it("⑥ 连拦封顶 3 次：恒阻断钩子第 4 停放行 + hooks/run 落 stop-cap 账；stop_hook_active 首停 false 续停 true", async () => {
    const { h, requests } = await setup({
      script: [textChunk("答"), textChunk("答"), textChunk("答"), textChunk("答")],
      hooksToml: `
[[hooks.Stop]]
[[hooks.Stop.hooks]]
command = "cat >> \\"\${OROSUS_PROJECT_DIR}/stopins\\"; echo 别停 >&2; exit 2"
`,
    });
    await h.prompt("干活");
    expect(requests).toHaveLength(4); // 3 次续跑后封顶放行
    const events = await h.history();
    expect(events.some((e) => e.type === "hooks/run" && JSON.stringify(e).includes("stop-cap"))).toBe(true);
    const { readFileSync: rfs } = await import("node:fs");
    const stdinLines = rfs(join(dir!, "stopins"), "utf8").split("\n").filter((l) => l.trim() !== "");
    expect(stdinLines.length).toBe(4); // 4 次停止边界各喂一次 stdin
    expect(JSON.parse(stdinLines[0]!).stop_hook_active).toBe(false); // 首停
    expect(JSON.parse(stdinLines[1]!).stop_hook_active).toBe(true); // 续停
    await h.close();
  });

  it("⑦ 新消息清零计数：封顶后的下一轮重新获得 3 次续跑额度", async () => {
    const { h, requests } = await setup({
      script: [textChunk("答"), textChunk("答"), textChunk("答"), textChunk("答"), textChunk("答"), textChunk("答"), textChunk("答"), textChunk("答")],
      hooksToml: `
[[hooks.Stop]]
[[hooks.Stop.hooks]]
command = "echo 别停 >&2; exit 2"
`,
    });
    await h.prompt("第一轮"); // 封顶 → 4 请求
    expect(requests).toHaveLength(4);
    await h.prompt("第二轮"); // 计数清零 → 又 3 续跑 + 1 = 4 请求
    expect(requests).toHaveLength(8);
    await h.close();
  });

  it("⑧ shouldStop 真停：Stop 钩子意见照落日志但不复活轮（CL-07——turn 照常收口）", async () => {
    const { h, requests } = await setup({
      script: [textChunk("答"), textChunk("答")],
      hooksToml: `
[[hooks.Stop]]
[[hooks.Stop.hooks]]
command = "echo 想续但被喊停 >&2; exit 2"
`,
    });
    h.graph().bus.on("agent/should-stop", () => true, "test-stopper");
    await h.prompt("干活");
    expect(requests).toHaveLength(1); // 没有续跑
    const events = await h.history();
    expect(events.some((e) => e.type === "turn/end")).toBe(true); // 轮正常收口
    const msgs = events.filter((e) => e.type === "agent/steering-message").flatMap((e) => ((e as { messages?: { text: string }[] }).messages ?? []));
    expect(msgs.some((m) => m.text.includes("钩子要求继续"))).toBe(true); // 意见照落日志（不静默丢）
    await h.close();
  });

  it("⑨ Stop reason 过帽：超大 stderr 理由截到 16k + 可读截断标记", async () => {
    const { h } = await setup({
      script: [textChunk("答"), textChunk("答")],
      hooksToml: `
[[hooks.Stop]]
[[hooks.Stop.hooks]]
command = "yes 理理理理理理理理理理理理理理理理理理理理 | head -c 100000 >&2; exit 2"
`,
    });
    await h.prompt("干活");
    const events = await h.history();
    const msgs = events.filter((e) => e.type === "agent/steering-message").flatMap((e) => ((e as { messages?: { text: string }[] }).messages ?? []));
    const cont = msgs.find((m) => m.text.includes("钩子要求继续"));
    expect(cont!.text).toContain("字符，保留前 16000]"); // 可读截断标记（原文超 16k）
    expect(cont!.text.length).toBeLessThan(17_000);
    await h.close();
  });

  it("⑩ JSON decision block（Claude Stop 同名形态）也能续跑：stopReason 优先", async () => {
    const { h, requests } = await setup({
      script: [textChunk("答"), textChunk("答")],
      hooksToml: `
[[hooks.Stop]]
[[hooks.Stop.hooks]]
command = 'test -f "\${OROSUS_PROJECT_DIR}/m2" && echo "{\\"decision\\":\\"approve\\"}" || { touch "\${OROSUS_PROJECT_DIR}/m2"; echo "{\\"decision\\":\\"block\\",\\"stopReason\\":\\"还差总结\\"}"; }'
`,
    });
    await h.prompt("干活");
    expect(requests).toHaveLength(2);
    const events = await h.history();
    expect(JSON.stringify(events)).toContain("还差总结");
    await h.close();
  });
});

describe("PermissionRequest 代答（m5-hooks T8——approval 服务倒挂）", () => {
  const setupWithApproval = async (hooksToml: string) => {
    const { createHarness } = await import("@orosus/core");
    const approval = (await import("@orosus/approval")).default;
    dir = mkdtempSync(join(tmpdir(), "orosus-hookperm-"));
    const executed: (string | undefined)[] = [];
    const providerMod = fakeModule("provider-fake", { activate(ctx) { ctx.provide(providerSlotKey("fake"), fakeProvider([toolChunk("c1", '{"v":"orig"}'), textChunk("收工")]).stream); } });
    const toolMod = fakeModule("m", {
      mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "m__t",
          description: "探针",
          parameters: z.object({ v: z.string().optional() }),
          resolveExecution: async (args: { v?: string }) => ({ accesses: [Access.subprocess()], approvalRule: `m__t(${args.v ?? ""} *)`, execute: async () => { executed.push(args.v); return { output: `ran:${args.v ?? ""}`, isError: false }; } }),
        }));
      },
    });
    const h = await createHarness({
      store: new InMemorySessionStore(),
      cwd: dir,
      sessionsDir: join(dir, "sessions"),
      diagDir: dir,
      spillDir: join(dir, "spill"),
      modules: [providerMod, toolMod, approval, hooksDef],
      config: { ...hermetic(dir, hooksToml), cliOverrides: { model: "fake/m" } },
    });
    return { h, executed };
  };

  it("① deny 代答：approval/requested 带 hooksVerdict、resolved source=hooks、工具拒绝且理由可见", async () => {
    const { h, executed } = await setupWithApproval(`
[[hooks.PermissionRequest]]
matcher = "^m__t$"
[[hooks.PermissionRequest.hooks]]
command = "echo '{\\"permissionDecision\\":\\"deny\\",\\"reason\\":\\"不批这个工具\\"}'"
`);
    await h.prompt("干活");
    const events = await h.history();
    const requested = events.find((e) => e.type === "approval/requested") as Record<string, unknown>;
    expect(requested?.hooksVerdict).toBe("deny");
    const resolved = events.find((e) => e.type === "approval/resolved") as Record<string, unknown>;
    expect(resolved).toMatchObject({ source: "hooks", decision: "deny", reason: "不批这个工具" });
    const result = events.find((e) => e.type === "tool/result") as { output?: string };
    expect(result?.output).toContain("钩子代答拒绝");
    expect(result?.output).toContain("不批这个工具");
    expect(executed).toEqual([]);
    await h.close();
  });

  it("② allow 代答：跳过弹窗直接放行（headless 无 commandUi——若走了弹窗会抛「无交互环境」拒绝）", async () => {
    const { h, executed } = await setupWithApproval(`
[[hooks.PermissionRequest]]
[[hooks.PermissionRequest.hooks]]
command = "echo '{\\"permissionDecision\\":\\"allow\\"}'"
`);
    await h.prompt("干活");
    expect(executed).toEqual(["orig"]); // 弹窗被跳过（headless 弹窗必炸）
    const resolved = (await h.history()).find((e) => e.type === "approval/resolved") as Record<string, unknown>;
    expect(resolved).toMatchObject({ source: "hooks", decision: "allow-once" });
    await h.close();
  });

  it("③ 未表态照旧弹窗：钩子 exit 0 无决策 → 走 ctx.ui 询问（headless = 抛「无交互环境」fail-closed）", async () => {
    const { h, executed } = await setupWithApproval(`
[[hooks.PermissionRequest]]
[[hooks.PermissionRequest.hooks]]
command = "exit 0"
`);
    await h.prompt("干活");
    const events = await h.history();
    const requested = events.find((e) => e.type === "approval/requested") as Record<string, unknown>;
    expect(requested?.hooksVerdict).toBeUndefined(); // 走了原始弹窗路径
    const result = events.find((e) => e.type === "tool/result") as { output?: string };
    expect(result?.output).toContain("无交互环境"); // headless 弹窗炸 = fail-closed 拒绝（证明弹窗路径被走）
    expect(executed).toEqual([]);
    await h.close();
  });

  it("④ 未配 PermissionRequest 表：服务在场但恒 undefined——弹窗路径照旧（同 ③ 形态）", async () => {
    const { h, executed } = await setupWithApproval(`
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "exit 0"
`);
    await h.prompt("干活");
    const result = (await h.history()).find((e) => e.type === "tool/result") as { output?: string };
    expect(result?.output).toContain("无交互环境");
    expect(executed).toEqual([]);
    await h.close();
  });
});

describe("项目级配置与 sha256 信任门（m5-hooks T9）", () => {
  const setupLayers = async (opts: { projectToml?: string; trustJson?: string; userToml?: string }) => {
    const { createHarness } = await import("@orosus/core");
    dir = mkdtempSync(join(tmpdir(), "orosus-hooktrust-"));
    const userHooks = opts.userToml ?? `
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "echo user-ok"
`;
    const projectFile = join(dir, "proj-hooks.toml");
    const trustFile = join(dir, "trust.json");
    if (opts.projectToml !== undefined) writeFileSync(projectFile, opts.projectToml, "utf8");
    if (opts.trustJson !== undefined) writeFileSync(trustFile, opts.trustJson, "utf8");
    const userFile = join(dir, "config.toml").split("\\").join("/");
    const gate = opts.projectToml !== undefined ? `\n\n[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ncommand = "proj-gate"` : "";
    writeFileSync(join(dir, "config.toml"), `provider = "fake/m"\n\n[hooks]\nuserConfigFile = "${userFile}"\nprojectConfigFile = "${projectFile.split("\\").join("/")}"\ntrustFile = "${trustFile.split("\\").join("/")}"\n${userHooks}${gate}`, "utf8");
    const executed: (string | undefined)[] = [];
    const script = [toolChunk("c1", '{"v":"orig"}'), textChunk("收工"), toolChunk("c2", '{"v":"orig"}'), textChunk("再收工")]; // 两轮各一次工具调用（④ 现算测试要第二轮还有工具）
    const providerMod = fakeModule("provider-fake", { activate(ctx) { ctx.provide(providerSlotKey("fake"), fakeProvider(script).stream); } });
    const toolMod = fakeModule("m", {
      mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "m__t",
          description: "探针",
          parameters: z.object({ v: z.string().optional() }),
          resolveExecution: async (args: { v?: string }) => ({ accesses: [], approvalRule: "m__t", execute: async () => { executed.push(args.v); return { output: `ran:${args.v ?? ""}`, isError: false }; } }),
        }));
      },
    });
    const h = await createHarness({
      store: new InMemorySessionStore(),
      cwd: dir,
      sessionsDir: join(dir, "sessions"),
      diagDir: dir,
      spillDir: join(dir, "spill"),
      modules: [providerMod, toolMod, hooksDef],
      config: { userFile: join(dir, "config.toml"), projectFile: join(dir, "no-proj.toml"), catalogCacheFile: join(dir, "no-cat.json"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    return { h, executed, projectFile, trustFile, cwd: dir };
  };

  const PROJ_DENY = `
[hooks]
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "cat > /dev/null; echo 项目层拦截 >&2; exit 2"
`;

  it("① 未信任不执行：项目层整层跳过（用户层照跑）、工具放行、hooks/run 记 skipped-untrusted", async () => {
    const { h, executed } = await setupLayers({ projectToml: PROJ_DENY });
    await h.prompt("干活");
    expect(executed).toEqual(["orig"]); // 项目层 deny 被门挡下——工具放行
    const events = await h.history();
    const runs = events.filter((e) => e.type === "hooks/run") as Record<string, unknown>[];
    expect(runs.some((r) => r.status === "skipped-untrusted")).toBe(true);
    expect(runs.some((r) => r.hook === "echo user-ok" && r.status === "pass")).toBe(true); // 用户层不受门影响
    await h.close();
  });

  it("② 信任后执行：trust 记录 digest 匹配 → 项目层 deny 生效", async () => {
    const probe = await setupLayers({ projectToml: PROJ_DENY });
    const digest = projectHooksDigest(probe.projectFile)!;
    writeFileSync(probe.trustFile, JSON.stringify({ [projectBucketKey(probe.cwd)]: { digest, trustedAt: "2026-10-04T00:00:00Z" } }), "utf8");
    await probe.h.prompt("干活");
    const result = (await probe.h.history()).find((e) => e.type === "tool/result") as { output?: string };
    expect(result?.output).toContain("项目层拦截");
    expect(probe.executed).toEqual([]);
    await probe.h.close();
  });

  it("③ 改配置 digest 变化重新待审：项目文件加表 → 旧信任记录失配 → 整层再跳过", async () => {
    const probe = await setupLayers({ projectToml: PROJ_DENY });
    writeFileSync(probe.trustFile, JSON.stringify({ [projectBucketKey(probe.cwd)]: { digest: projectHooksDigest(probe.projectFile)!, trustedAt: "t" } }), "utf8");
    writeFileSync(probe.projectFile, `${PROJ_DENY}\n[[hooks.PostToolUse]]\n[[hooks.PostToolUse.hooks]]\ncommand = "exit 0"\n`, "utf8"); // 内容变（非注释）→ digest 变
    await probe.h.prompt("干活");
    expect(probe.executed).toEqual(["orig"]); // 失配 → 门关
    await probe.h.close();
  });

  it("④ 每次派发前现算（不缓存）：同会话先未信任（放行）→ 写信任记录 → 下一轮项目层即生效（零 reload）", async () => {
    const probe = await setupLayers({ projectToml: PROJ_DENY });
    await probe.h.prompt("第一轮");
    expect(probe.executed).toEqual(["orig"]); // 未信任
    writeFileSync(probe.trustFile, JSON.stringify({ [projectBucketKey(probe.cwd)]: { digest: projectHooksDigest(probe.projectFile)!, trustedAt: "t" } }), "utf8");
    await probe.h.prompt("第二轮");
    const result = (await probe.h.history()).filter((e) => e.type === "tool/result").at(-1) as { output?: string };
    expect(result?.output).toContain("项目层拦截"); // 现算生效——无须 reload
    await probe.h.close();
  });

  it("⑤ 信任文件损坏容错：坏 JSON 当无记录（项目层待审——fail-closed 方向）", async () => {
    const { h, executed } = await setupLayers({ projectToml: PROJ_DENY, trustJson: "{not json at all" });
    await h.prompt("干活");
    expect(executed).toEqual(["orig"]);
    await h.close();
  });

  it("⑥ 无项目层：门不适用——零 skipped-untrusted 记录、用户层照跑", async () => {
    const { h, executed } = await setupLayers({});
    await h.prompt("干活");
    expect(executed).toEqual(["orig"]);
    const runs = (await h.history()).filter((e) => e.type === "hooks/run") as Record<string, unknown>[];
    expect(runs.some((r) => r.status === "skipped-untrusted")).toBe(false);
    await h.close();
  });
});

describe("信任门原语（m5-hooks T9 unit）", () => {
  it("⑦ canonicalJson 键序无关：同内容异序 digest 相同（嵌套递归）", async () => {
    const { createHash } = await import("node:crypto");
    const { canonicalJson } = await import("./trust.ts");
    const a = canonicalJson({ b: [1, { z: 1, a: 2 }], a: "x" });
    const b = canonicalJson({ a: "x", b: [1, { a: 2, z: 1 }] });
    expect(a).toBe(b);
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
  });

  it("⑧ 盘符大小写归一：C:/x 与 c:/x 同桶（resolve+win32 toLowerCase 前置——encodeCwd 自身不归一，四轮审修口径）", async () => {
    const { projectBucketKey } = await import("./trust.ts");
    if (process.platform === "win32") {
      expect(projectBucketKey("C:\\Develop\\Orosus")).toBe(projectBucketKey("c:\\develop\\orosus"));
    } else {
      expect(projectBucketKey("/a/b")).toBe(projectBucketKey("/a/b")); // POSIX 恒等对照
    }
  });

  it("⑨ 信任路径缺省值：~/.orosus/hooks/hooks-trust.json（用户拍板 hooks/ 新目录）", async () => {
    const { trustFilePath } = await import("./trust.ts");
    expect(trustFilePath()).toContain(join("hooks", "hooks-trust.json"));
  });
});

describe("阻断明示与顺序回归钉（m5-hooks T11）", () => {
  it("① 提交阻断明示（qwen 形态）：钩子名 + 理由 + 被拒原文首行摘要（长文截 40 + 省略号）", async () => {
    const { h } = await setup({
      script: [textChunk("ok")],
      hooksToml: `
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
command = "python3 guard.py"
`.replace("python3 guard.py", "cat > /dev/null; echo 话题被禁 >&2; exit 2"),
    });
    const longText = `这条消息${"很长".repeat(25)}`;
    await expect(h.prompt(longText)).rejects.toThrow(`钩子（cat）拦截：话题被禁｜被拒原文「${longText.slice(0, 40)}…」`); // 程序化构造——40 帽与省略号口径同源
    await expect(h.prompt("短话")).rejects.toThrow(/钩子（cat）拦截：话题被禁｜被拒原文「短话」/);
    await h.close();
  });

  it("② 顺序钉·改参后审批链见派生新参数：PreToolUse 改 v → tool/pre-execute 监听者收到新 approvalRule（写闸判定面）", async () => {
    const { h } = await setup({ hooksToml: PRE_REWRITE });
    const approvals: string[] = [];
    h.graph().bus.on("tool/pre-execute", (p) => { approvals.push(String((p as { approvalRule?: string }).approvalRule)); }, "test-gate");
    await h.prompt("干活");
    expect(apporvals_safe(approvals)).toEqual(["m__t(rewritten *)"]); // 写闸只见最终参数派生的规则（T1 重解链端到端）
    await h.close();
  });

  it("③ 顺序钉·子代理端到端（D18）：主对话配置的 PreToolUse 拦截子代理工具（hooks/run 带身份）+ PostToolUseFailure 收到子代理结果", async () => {
    const { createHarness } = await import("@orosus/core");
    const toolSubagent = (await import("@orosus/tool-subagent")).default;
    dir = mkdtempSync(join(tmpdir(), "orosus-hooksub-"));
    const userFile = join(dir, "config.toml").split("\\").join("/");
    writeFileSync(join(dir, "config.toml"), `provider = "fake/m"\n\n[hooks]\nuserConfigFile = "${userFile}"\ntimeoutMs = 8000\n\n[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ncommand = "cat > /dev/null; echo 子代理不许跑 >&2; exit 2"\n\n[[hooks.PostToolUseFailure]]\n[[hooks.PostToolUseFailure.hooks]]\ncommand = "echo '{\\"additionalContext\\":\\"子代理失败善后\\"}'"\n`, "utf8");
    const subChunk = (callId: string): Chunk[] => [
      { type: "toolcall/argumentsDelta", callId, name: "m__t", argumentsDelta: "{}" },
      { type: "finish", kind: "stop" },
    ];
    let port: import("@orosus/contracts/module").SubagentPort | undefined;
    const consumer = fakeModule("consumer", { mounts: ["subagent"], activate(ctx) { port = ctx.subagent; } });
    const providerMod = fakeModule("provider-fake", { activate(ctx) { ctx.provide(providerSlotKey("fake"), fakeProvider([subChunk("sc1"), textChunk("子代理结论")]).stream); } });
    const toolMod = fakeModule("m", {
      mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "m__t", description: "探针", parameters: z.object({}),
          resolveExecution: async () => ({ accesses: [], approvalRule: "m__t", execute: async () => ({ output: "ran", isError: false }) }),
        }));
      },
    });
    const h = await createHarness({
      store: new InMemorySessionStore(), cwd: dir, sessionsDir: join(dir, "sessions"), diagDir: dir, spillDir: join(dir, "spill"),
      modules: [providerMod, toolMod, toolSubagent, hooksDef, consumer],
      config: { userFile: join(dir, "config.toml"), projectFile: join(dir, "no-proj.toml"), catalogCacheFile: join(dir, "no-cat.json"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    const out = (await port!.spawn({ label: "钩子管得住", prompt: "去跑工具" })) as { status: string };
    expect(out.status).toBe("completed");
    const events = await h.history();
    const runs = events.filter((e) => e.type === "hooks/run") as Record<string, unknown>[];
    const denyRun = runs.find((r) => r.status === "deny");
    expect(denyRun?.subagent).toMatch(/^[0-9a-f]{8}$/); // 转发链含身份（D18——agentId 即 8 位 hex，agents_ 前缀是目录名）
    expect(denyRun?.reason).toBe("子代理不许跑");
    const failureRun = runs.find((r) => r.event === "PostToolUseFailure");
    expect(failureRun).toBeDefined(); // PostToolUseFailure 钩子收到了子代理的失败结果（拒绝即失败）
    expect(JSON.stringify(events)).toContain("子代理失败善后");
    await h.close();
  });

  it("④ 状态行 N/M：两枚慢钩子（sleep 0.5s）的 running 账各带 index/total（1/2、2/2）——cc 形态计数", async () => {
    const { h } = await setup({
      hooksToml: `
timeoutMs = 5000

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "sleep 0.5"

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
command = "sleep 0.5"
`,
    });
    await h.prompt("干活");
    const runs = (await h.history()).filter((e) => e.type === "hooks/run") as Record<string, unknown>[];
    const runnings = runs.filter((r) => r.status === "running");
    expect(runnings.map((r) => `${r.index}/${r.total}`)).toEqual(["1/2", "2/2"]);
    expect(runs.filter((r) => r.status === "pass")).toHaveLength(2); // 都慢到显形了且正常完成
    await h.close();
  });
});

const apporvals_safe = (a: string[]): string[] => a; // 断言助手（直通——命名防与 approvals 变量撞）
