import { describe, it, expect } from "vitest";
import { sanitizeToolMeta, digest, toBridgedTool } from "./bridge.ts";
import { activateMcp, collectTools, runTool } from "./index.ts";
import type { Tool } from "@orosus/contracts/tool";

const fakeList = [
  { name: "create_issue", description: "创建 issue" },
  { name: "evil", description: "x".repeat(9000) },
];

describe("mcp 桥接（§6.3 两规则 + §8.5 不受信 description）", () => {
  it("① 工具映射：server 工具 → mcp__<server>__<tool> 注册", () => {
    const tools = fakeList.map((t) => toBridgedTool("github", t, async () => ({ content: [{ type: "text", text: "ok" }] })));
    expect(tools.map((t) => (t as Tool).name)).toEqual(["mcp__github__create_issue", "mcp__github__evil"]);
  });

  it("② 调用桥接：参数透传 → client.callTool → 输出字符串化", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const tool = toBridgedTool("gh", { name: "ping", description: "d" }, async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "pong" }] };
    });
    const r = await runTool(tool, { x: 1 });
    expect(r.output).toBe("pong");
    expect(calls[0]).toEqual({ name: "ping", args: { x: 1 } });
  });

  it("③ 未配置 accesses → 缺省 [Access.all()]（fail-closed，§6.3）", async () => {
    const tool = toBridgedTool("s", { name: "t", description: "d" }, async () => ({ content: [] }), undefined);
    const exec = await tool.resolveExecution({});
    expect(exec.accesses).toEqual([{ kind: "all" }]);
  });

  it("④ server 级 accesses 配置生效（只读声明透传）", async () => {
    const tool = toBridgedTool("s", { name: "t", description: "d" }, async () => ({ content: [] }), [{ kind: "fs.read", path: "/repo" }]);
    const exec = await tool.resolveExecution({});
    expect(exec.accesses).toEqual([{ kind: "fs.read", path: "/repo" }]);
  });

  it("⑤ description 不受信输入：超长截断 + 来源标记前缀", () => {
    const clean = sanitizeToolMeta("gh", "evil", "x".repeat(9000));
    expect(clean.description.length).toBeLessThan(4200);
    expect(clean.description.startsWith("[mcp:gh]")).toBe(true);
    // 非 string 描述按空串处理
    const weird = sanitizeToolMeta("gh", "t", 42 as never);
    expect(weird.description).toBe("[mcp:gh]");
  });

  it("⑥ 清单快照：连接一次取全量，digest 记 server 侧清单（mcp/manifest 事件的载荷）", () => {
    const d = digest({ gh: ["a", "b"], x: [] });
    expect(d).toHaveLength(64);
    const d2 = digest({ gh: ["a", "b"], x: [] });
    expect(d).toBe(d2); // 确定性
    expect(digest({ gh: ["b", "a", "c"], x: [] })).not.toBe(d); // 增删敏感（顺序在 digest 内规范化）
  });

  it("⑦ mcp/manifest 事件：activate 后落 server 清单 digest（logEvents 声明 + session append）", async () => {
    
    const logged: Array<{ t: string; p: Record<string, unknown> }> = [];
    
    await activateMcp({
      servers: { gh: { command: "npx", args: ["-y", "fake-server"] } },
      connect: async () => ({ listTools: async () => fakeList, callTool: async () => ({ content: [] }) }),
      sessionAppend: (t: string, p: Record<string, unknown>) => void logged.push({ t, p }),
    });
    const manifest = logged.find((x: { t: string }) => x.t === "mcp/manifest");
    expect(manifest).toBeDefined();
    expect(String(manifest!.p.digest)).toHaveLength(64);
  });

  it("⑧ server 连接失败 → 该 server 工具组零注册 + 模块不整体降级", async () => {
    
    const out = await activateMcp({
      servers: {
        good: { command: "x" },
        bad: { command: "y" },
      },
      connect: async (name: string) => {
        if (name === "bad") throw new Error("connect fail");
        return { listTools: async () => [{ name: "ok_tool", description: "d" }], callTool: async () => ({ content: [] }) };
      },
      sessionAppend: () => {},
    });
    const names = collectTools(out).map((t: { name: string }) => t.name);
    expect(names).toEqual(["mcp__good__ok_tool"]); // bad 的工具零注册
    expect(out.failedServers).toEqual(["bad"]); // 记录失败但不整体降级
  });
});
