// T1（m4-3c）：连接层——并发连接 + 启动超时 + 说明书方法名修复。
// e2e 走 T0 假 server（tests/fixtures/mcp-fixture-server.mjs）；并发与失败面用注入 connect 单测 activateMcp。
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { createSdkConnection, DEFAULT_CONNECT_TIMEOUT_MS } from "./client.ts";
import { activateMcp } from "./index.ts";

const FIXTURE = fileURLToPath(new URL("../../../../tests/fixtures/mcp-fixture-server.mjs", import.meta.url));

const fixtureServer = (env: Record<string, string> = {}) => ({
  command: "node",
  args: [FIXTURE],
  env,
});

const race = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))]);

describe("T1 并发连接 + 启动超时 + 说明书修复（m4-3c）", () => {
  it("① 并发：三 server 各延迟 150ms——总耗时 < 350ms（串行 ≥ 450ms）；全数连上", async () => {
    const t0 = Date.now();
    const out = await activateMcp({
      servers: { a: { command: "x" }, b: { command: "y" }, c: { command: "z" } },
      connect: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { listTools: async () => [{ name: "t", description: "d" }], callTool: async () => ({ content: [] }) };
      },
      sessionAppend: () => {},
    });
    expect(out.connected).toHaveLength(3);
    expect(Date.now() - t0).toBeLessThan(350);
  });

  it("② 失败名单升级：名字 + 原因（不再裸名数组）；失败不株连其余 server", async () => {
    const out = await activateMcp({
      servers: {
        good: { command: "ok" },
        bad: { command: "nope" },
      },
      connect: async (name) => {
        if (name === "bad") throw new Error("spawn ENOENT: nope");
        return { listTools: async () => [{ name: "t", description: "d" }], callTool: async () => ({ content: [] }) };
      },
      sessionAppend: () => {},
    });
    expect(out.failedServers).toEqual([{ name: "bad", reason: expect.stringContaining("ENOENT") }]);
    expect(out.connected.map((s) => s.name)).toEqual(["good"]);
  });

  it("③ 默认连接超时 = 30 秒（kimi 同值钉）", () => {
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(30_000);
  });

  it("④ e2e 超时：fixture 堵 initialize 2s、帽 300ms → 拒绝且文案人话（连接超时 + 时长）", async () => {
    await expect(
      createSdkConnection("fx", fixtureServer({ FIXTURE_INIT_DELAY: "2000" }), { connectTimeoutMs: 300 }),
    ).rejects.toThrow(/连接超时/);
  });

  it("⑤ e2e 说明书修复：FIXTURE_INSTRUCTIONS 经 getInstructions 真正取到（旧 getServerInstructions 恒空）", async () => {
    const conn = await race(
      createSdkConnection("fx", fixtureServer({ FIXTURE_INSTRUCTIONS: "fixture 说明书正文" })),
      15_000,
      "connect",
    );
    try {
      await expect(conn.instructions!()).resolves.toBe("fixture 说明书正文");
    } finally {
      await conn.close?.();
    }
  });

  it("⑥ e2e activateMcp 全链：真 SDK connect + fixture → 连上、工具桥接、instructions 消毒入 connected", async () => {
    const out = await race(
      activateMcp({
        servers: { fx: fixtureServer({ FIXTURE_INSTRUCTIONS: "全链说明书" }) },
        connect: (name, cfg) => createSdkConnection(name, cfg),
        sessionAppend: () => {},
      }),
      20_000,
      "activateMcp",
    );
    try {
      expect(out.failedServers).toEqual([]);
      expect(out.connected).toHaveLength(1);
      expect(out.connected[0]!.instructions).toBe("[mcp:fx] 全链说明书");
      expect(out.tools.map((t) => t.name)).toContain("mcp__fx__echo");
    } finally {
      await out.close();
    }
  });
});
