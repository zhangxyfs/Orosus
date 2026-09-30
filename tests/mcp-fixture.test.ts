// T0（m4-3c）：测试用假 MCP server 的自检——fixture 本体在 tests/fixtures/mcp-fixture-server.mjs。
// 后续连接类任务（T1–T7）与内容类任务（T8–T9）全拿它当靶子；本文件钉「靶子本身是好的」：
// stdio 模式三工具通、env 旋钮生效、instructions 通道通、HTTP 模式可连可调。
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url));

const procs: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) {
    if (!p.killed) p.kill();
  }
});

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);

/** stdio 连 fixture——env 旋钮透传给子进程。 */
async function connectStdio(env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({ command: "node", args: [FIXTURE], env });
  const client = new Client({ name: "t0", version: "0.0.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), 10_000, "stdio connect");
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return { client, transport };
}

describe("T0 假 server（m4-3c MCP 生产化）", () => {
  it("stdio 三工具：listTools 含 echo/time/fail；echo 回显；fail 带 isError", async () => {
    const { client } = await connectStdio();
    try {
      const list = await withTimeout(client.listTools({}), 10_000, "listTools");
      const names = list.tools.map((t) => t.name);
      for (const want of ["echo", "time", "fail"]) expect(names).toContain(want);

      const echoed = (await withTimeout(
        client.callTool({ name: "echo", arguments: { message: "你好靶子" } }),
        10_000,
        "echo",
      )) as { content: { type: string; text?: string }[] };
      expect(echoed.content[0]?.text).toBe("你好靶子");

      const failed = (await withTimeout(
        client.callTool({ name: "fail", arguments: {} }),
        10_000,
        "fail",
      )) as { isError?: boolean; content: { text?: string }[] };
      expect(failed.isError).toBe(true);
      expect(failed.content[0]?.text).toContain("boom");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("env 旋钮：FIXTURE_TOOL_COUNT=5 → bulk0..bulk4 入列；FIXTURE_INSTRUCTIONS → getInstructions", async () => {
    const { client } = await connectStdio({ FIXTURE_TOOL_COUNT: "5", FIXTURE_INSTRUCTIONS: "靶子说明书" });
    try {
      const list = await withTimeout(client.listTools({}), 10_000, "listTools");
      const bulk = list.tools.map((t) => t.name).filter((n) => n.startsWith("bulk"));
      expect(bulk).toEqual(["bulk0", "bulk1", "bulk2", "bulk3", "bulk4"]);
      expect(client.getInstructions()).toBe("靶子说明书");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("分页旋钮：FIXTURE_PAGE_SIZE=3 → 首页 3 条 + nextCursor，翻页取全", async () => {
    const { client } = await connectStdio({ FIXTURE_TOOL_COUNT: "5", FIXTURE_PAGE_SIZE: "3" });
    try {
      const names: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await withTimeout(
          client.listTools(cursor !== undefined ? { cursor } : {}),
          10_000,
          `listTools page ${pages}`,
        );
        names.push(...page.tools.map((t) => t.name));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect(pages).toBeGreaterThanOrEqual(4); // 14+ 工具 / 每页 3 → 至少 5 页
      expect(names.filter((n) => n.startsWith("bulk"))).toHaveLength(5);
      expect(new Set(names).size).toBe(names.length); // 翻页不重不漏
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("HTTP 模式：StreamableHTTPClientTransport 连上、echo 通、headers 工具回显请求头", async () => {
    const proc = spawn("node", [FIXTURE], {
      env: { ...process.env, FIXTURE_HTTP: "1", FIXTURE_PORT: "0" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    procs.push(proc);
    const port = await withTimeout(
      new Promise<number>((resolve, reject) => {
        proc.stdout!.on("data", (d: Buffer) => {
          const m = /FIXTURE_HTTP_READY (\d+)/.exec(d.toString("utf8"));
          if (m !== null) resolve(Number(m[1]));
        });
        proc.on("exit", (code) => reject(new Error(`fixture http 退出 code=${code}`)));
      }),
      10_000,
      "http ready",
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: "Bearer t0-token" } },
    });
    const client = new Client({ name: "t0", version: "0.0.0" }, { capabilities: {} });
    try {
      await withTimeout(client.connect(transport as never), 10_000, "http connect"); // SDK 传输联合类型在 exactOptionalPropertyTypes 下的摩擦——运行时无歧义（同 mcp/index.ts）
      const echoed = (await withTimeout(
        client.callTool({ name: "echo", arguments: { message: "http 靶子" } }),
        10_000,
        "http echo",
      )) as { content: { text?: string }[] };
      expect(echoed.content[0]?.text).toBe("http 靶子");

      const headers = (await withTimeout(
        client.callTool({ name: "headers", arguments: {} }),
        10_000,
        "http headers",
      )) as { content: { text?: string }[] };
      const got = JSON.parse(headers.content[0]!.text!) as Record<string, string>;
      expect(got.authorization).toBe("Bearer t0-token");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
