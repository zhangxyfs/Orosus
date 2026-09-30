// T1（m4-3c）：连接层——并发连接 + 启动超时 + 说明书方法名修复。
// e2e 走 T0 假 server（tests/fixtures/mcp-fixture-server.mjs）；并发与失败面用注入 connect 单测 activateMcp。
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { createSdkConnection, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS, collectAllPages, MAX_LIST_PAGES } from "./client.ts";
import { activateMcp, mcpDef } from "./index.ts";

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

describe("T2 调用超时 + 进度顺延（m4-3c）", () => {
  it("① 默认调用超时 = 60 秒（自定值钉：比 opencode 默认宽一档）", () => {
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(60_000);
  });

  it("② schema：server 级 timeoutMs 正数过、非法拒", () => {
    const schema = mcpDef.config!;
    expect(schema.safeParse({ servers: { s: { command: "x", timeoutMs: 120_000 } } }).success).toBe(true);
    expect(schema.safeParse({ servers: { s: { command: "x", timeoutMs: "大" } } }).success).toBe(false);
    expect(schema.safeParse({ servers: { s: { command: "x", timeoutMs: -1 } } }).success).toBe(false);
  });

  it("③ e2e 超时：slow 撑 1.2s、帽 300ms → 拒绝且文案人话（可能已完成 + 没有自动重试 + timeoutMs 指路）", async () => {
    const conn = await race(createSdkConnection("fx", fixtureServer(), { callTimeoutMs: 300 }), 15_000, "connect");
    try {
      await expect(
        race(
          conn.callTool("slow", { ms: 1200, message: "x" }, new AbortController().signal),
          10_000,
          "slow",
        ),
      ).rejects.toThrow(/调用超时.*没有自动重试.*timeoutMs/s);
    } finally {
      await conn.close?.();
    }
  });

  it("④ e2e 进度顺延（opencode 技巧钉）：progress_loop 每 80ms 汇报、撑 1s；帽 400ms——空 onprogress 激活顺延后撑得过（无回调形态 400ms 必死）", async () => {
    const conn = await race(createSdkConnection("fx", fixtureServer()), 15_000, "connect");
    try {
      const res = (await race(
        conn.callTool("progress_loop", { interval: 80, hold: 1000 }, new AbortController().signal),
        15_000,
        "progress_loop",
      )) as { content: { text?: string }[] };
      expect(res.content[0]?.text).toMatch(/progressed \d+/);
    } finally {
      await conn.close?.();
    }
  });

  it("⑤ server 级 timeoutMs 覆盖：cfg.timeoutMs=200 生效（800ms 慢调用到帽即死）", async () => {
    const capped = await race(
      createSdkConnection("fx", { ...fixtureServer(), timeoutMs: 200 }),
      15_000,
      "connect-capped",
    );
    try {
      await expect(
        race(capped.callTool("slow", { ms: 800 }, new AbortController().signal), 10_000, "slow"),
      ).rejects.toThrow(/调用超时/);
    } finally {
      await capped.close?.();
    }
  });
});

describe("T3 工具清单翻页到底（m4-3c）", () => {
  it("① 纯翻页助手：多页按序取全、nextCursor 缺省即止", async () => {
    const calls: (string | undefined)[] = [];
    const all = await collectAllPages(async (cursor) => {
      calls.push(cursor);
      if (cursor === undefined) return { tools: ["a", "b"], nextCursor: "p2" };
      if (cursor === "p2") return { tools: ["c"], nextCursor: "p3" };
      return { tools: ["d"] };
    });
    expect(all).toEqual(["a", "b", "c", "d"]);
    expect(calls).toEqual([undefined, "p2", "p3"]);
  });

  it("② 死循环保险（opencode 同款）：同一 nextCursor 出现第二次即停——不刷一千页", async () => {
    let pages = 0;
    const all = await collectAllPages(async () => {
      pages += 1;
      return { tools: ["x"], nextCursor: "loop" };
    });
    expect(pages).toBe(2); // 第 1 页拿到 loop（首见续翻）→ 第 2 页又给 loop（再见即停）
    expect(all).toEqual(["x", "x"]);
  });

  it("③ 页数帽 = 1000（opencode 同款上限钉）：游标恒新（死循环保险不触发）也到帽即停", async () => {
    expect(MAX_LIST_PAGES).toBe(1000);
    let pages = 0;
    const all = await collectAllPages(async () => {
      pages += 1;
      return { tools: [String(pages)], nextCursor: `c${pages}` };
    });
    expect(pages).toBe(1000);
    expect(all).toHaveLength(1000);
  });

  it("④ e2e：fixture 每页 3 条 + 5 个 bulk 工具 → 翻到底全量（20 条、含末页 bulk4 与点号名）", async () => {
    const conn = await race(
      createSdkConnection("fx", fixtureServer({ FIXTURE_TOOL_COUNT: "5", FIXTURE_PAGE_SIZE: "3" })),
      15_000,
      "connect",
    );
    try {
      const list = await race(conn.listTools(), 15_000, "listTools");
      const names = (list as { name: string }[]).map((t) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("bulk4"); // 末页也在
      expect(names).toContain("dot.name");
      expect(names).toContain("dot_name");
      expect(new Set(names).size).toBe(names.length); // 不重不漏
      expect(names.length).toBeGreaterThanOrEqual(20);
    } finally {
      await conn.close?.();
    }
  });
});
